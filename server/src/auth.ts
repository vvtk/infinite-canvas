import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { challenge, decrypt, digest, encrypt, localReturnPath, randomToken } from "./crypto.js";
import { transaction } from "./db.js";
import { z } from "zod";

const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() });
const profileSchema = z.object({ sub: z.string().min(1), username: z.string(), display_name: z.string(), avatar_url: z.string().optional(), role: z.number().int().nonnegative().default(1), quota: z.number().int().nonnegative().default(0), used_quota: z.number().int().nonnegative().default(0) });
const accountProfileSchema = z.object({ success: z.literal(true), data: profileSchema.omit({ sub: true }).extend({ id: z.number().int().positive() }) });
const walletSettingsSchema = z.object({ success: z.literal(true), data: z.object({ quota_display_type: z.enum(["USD", "CNY", "CUSTOM", "TOKENS"]), quota_per_unit: z.number().positive(), usd_exchange_rate: z.number().positive(), custom_currency_exchange_rate: z.number().positive() }) });
const oauthScope = "api_key:read api_key:write api_key:reveal model_inference:use profile:read wallet:read";
const clientHeaders = { "User-Agent": "InfiniteCanvas" };
export type Credentials = { accessToken: string; refreshToken: string; expiresAt: number };
export type Session = { userId: string; hash: string; credentials: Credentials };

export function authService(app: FastifyInstance, pool: Pool, config: Config) {
    const cookie = { httpOnly: true, secure: new URL(config.PUBLIC_URL).protocol === "https:", sameSite: "lax" as const, path: "/" };
    const redirectUri = new URL("/api/auth/callback", config.PUBLIC_URL).href;
    const cookieName = cookie.secure ? "__Host-canvas-session" : "canvas-session";
    const flowCookie = cookie.secure ? "__Host-canvas-flow" : "canvas-flow";
    const accountUsers = new Map<string, { expiresAt: number; value: ReturnType<typeof loadAccountUser> }>();
    async function loadAccountUser(current: Session) {
        const { data } = accountProfileSchema.parse(await (await authorized(current, "/api/user/self")).json());
        const profile = { ...data, sub: String(data.id) };
        const balance = await walletBalance(profile);
        return { id: current.userId, displayId: profile.sub, username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url || "", ...balance, role: profile.role, isAdmin: profile.role >= 10 };
    }
    async function cachedAccountUser(current: Session) {
        const now = Date.now();
        for (const [key, value] of accountUsers) if (value.expiresAt <= now) accountUsers.delete(key);
        const cached = accountUsers.get(current.hash);
        if (cached) return cached.value;
        const entry = { expiresAt: Infinity, value: loadAccountUser(current) };
        accountUsers.set(current.hash, entry);
        try {
            const user = await entry.value;
            entry.expiresAt = Date.now() + 5 * 60 * 1000;
            return user;
        } catch (error) {
            accountUsers.delete(current.hash);
            throw error;
        }
    }
    async function walletBalance(profile: z.infer<typeof profileSchema>) {
        const response = await fetch(new URL("/api/status", config.LLMROAM_URL), { headers: clientHeaders });
        if (!response.ok) throw Object.assign(new Error(response.status === 429 ? "LLMRoam 请求过于频繁，请稍后重试" : "无法获取 LLMRoam 余额换算配置"), { statusCode: response.status === 429 ? 429 : 502 });
        const settings = walletSettingsSchema.safeParse(await response.json());
        if (!settings.success) throw Object.assign(new Error("LLMRoam 余额换算配置无效"), { statusCode: 502 });
        const { quota_display_type, quota_per_unit, usd_exchange_rate, custom_currency_exchange_rate } = settings.data.data;
        const exchangeRate = quota_display_type === "CUSTOM" ? custom_currency_exchange_rate : quota_display_type === "CNY" ? usd_exchange_rate : 1;
        const convert = (quota: number) => quota_display_type === "TOKENS" ? quota : quota / quota_per_unit * exchangeRate;
        return { points: convert(profile.quota), usedPoints: convert(profile.used_quota) };
    }
    async function tokenRequest(params: URLSearchParams) {
        const response = await fetch(new URL("/api/oauth-provider/token", config.LLMROAM_URL), {
            method: "POST", headers: { ...clientHeaders, Authorization: `Basic ${Buffer.from(`${config.OAUTH_CLIENT_ID}:${config.OAUTH_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: params,
        });
        if (!response.ok) throw Object.assign(new Error(response.status === 429 ? "LLMRoam 请求过于频繁，请稍后重试" : "授权凭据已失效，请重新登录"), { statusCode: response.status === 429 ? 429 : 401 });
        const result = tokenSchema.parse(await response.json());
        return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 };
    }
    async function session(request: FastifyRequest): Promise<Session | null> {
        const raw = request.cookies[cookieName];
        if (!raw) return null;
        const hash = digest(raw);
        const result = await pool.query("SELECT user_id, credentials FROM canvas_sessions WHERE id_hash=$1 AND expires_at>now()", [hash]);
        if (!result.rowCount) return null;
        return { userId: result.rows[0].user_id, hash, credentials: decrypt<Credentials>(result.rows[0].credentials, config.ENCRYPTION_KEY) };
    }
    async function requireSession(request: FastifyRequest) {
        const result = await session(request);
        if (!result) throw Object.assign(new Error("请先登录"), { statusCode: 401 });
        return result;
    }
    async function authorized(session: Session, path: string, method = "GET") {
        // Serialize refresh rotation across concurrent requests and server instances.
        const credentials = await transaction(pool, async (db) => {
            const result = await db.query("SELECT credentials FROM canvas_sessions WHERE id_hash=$1 AND expires_at>now() FOR UPDATE", [session.hash]);
            if (!result.rowCount) throw Object.assign(new Error("请重新登录"), { statusCode: 401 });
            let value = decrypt<Credentials>(result.rows[0].credentials, config.ENCRYPTION_KEY);
            if (value.expiresAt <= Date.now()) {
                value = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: value.refreshToken }));
                await db.query("UPDATE canvas_sessions SET credentials=$1 WHERE id_hash=$2", [encrypt(value, config.ENCRYPTION_KEY), session.hash]);
            }
            return value;
        });
        const response = await fetch(new URL(path, config.LLMROAM_URL), { method, headers: { ...clientHeaders, Authorization: `Bearer ${credentials.accessToken}` } });
        if (!response.ok) throw Object.assign(new Error(response.status === 429 ? "LLMRoam 请求过于频繁，请稍后重试" : "LLMRoam 授权请求失败，请重新登录"), { statusCode: response.status === 429 ? 429 : response.status === 401 ? 401 : 502 });
        return response;
    }
    app.get("/api/auth/login", async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const state = randomToken();
        const verifier = randomToken();
        await pool.query("DELETE FROM canvas_oauth_flows WHERE expires_at<=now()");
        await pool.query("INSERT INTO canvas_oauth_flows VALUES ($1,$2,$3,$4)", [digest(state), encrypt(verifier, config.ENCRYPTION_KEY), localReturnPath(query.returnTo), new Date(Date.now() + config.OAUTH_FLOW_SECONDS * 1000)]);
        reply.setCookie(flowCookie, state, { ...cookie, maxAge: config.OAUTH_FLOW_SECONDS });
        const url = new URL(config.OAUTH_AUTHORIZE_URL);
        url.search = new URLSearchParams({ response_type: "code", client_id: config.OAUTH_CLIENT_ID, redirect_uri: redirectUri, scope: oauthScope, state, code_challenge: challenge(verifier), code_challenge_method: "S256" }).toString();
        reply.header("Cache-Control", "no-store");
        return reply.redirect(url.href);
    });
    app.get("/api/auth/callback", async (request, reply) => {
        const query = z.object({ state: z.string().min(1), code: z.string().optional(), error: z.string().optional() }).parse(request.query);
        reply.clearCookie(flowCookie, cookie).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        if (query.state !== request.cookies[flowCookie]) return reply.code(400).send({ message: "登录状态校验失败，请重新登录" });
        const flow = await pool.query("DELETE FROM canvas_oauth_flows WHERE state_hash=$1 AND expires_at>now() RETURNING *", [digest(query.state)]);
        if (!flow.rowCount) return reply.code(400).send({ message: "授权流程已过期或已使用" });
        if (query.error || !query.code) {
            const target = new URL(flow.rows[0].return_path, config.PUBLIC_URL);
            target.searchParams.set("auth_error", query.error || "access_denied");
            return reply.redirect(`${target.pathname}${target.search}`);
        }
        const credentials = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri, code_verifier: decrypt<string>(flow.rows[0].verifier, config.ENCRYPTION_KEY) }));
        const response = await fetch(new URL("/api/oauth-provider/userinfo", config.LLMROAM_URL), { headers: { ...clientHeaders, Authorization: `Bearer ${credentials.accessToken}` } });
        if (!response.ok) throw Object.assign(new Error("无法获取授权用户信息"), { statusCode: 502 });
        const profile = profileSchema.parse(await response.json());
        const balance = await walletBalance(profile);
        const userId = digest(`${new URL(config.LLMROAM_URL).origin}\n${profile.sub}`);
        const raw = randomToken();
        await transaction(pool, async (db) => {
            await db.query("INSERT INTO canvas_users(id,profile) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET profile=EXCLUDED.profile", [userId, { id: userId, displayId: profile.sub, username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url || "", role: profile.role, ...balance }]);
            if (request.cookies[cookieName]) await db.query("DELETE FROM canvas_sessions WHERE id_hash=$1", [digest(request.cookies[cookieName]!)]);
            await db.query("INSERT INTO canvas_sessions VALUES($1,$2,$3,$4)", [digest(raw), userId, encrypt(credentials, config.ENCRYPTION_KEY), new Date(Date.now() + config.SESSION_SECONDS * 1000)]);
        });
        reply.setCookie(cookieName, raw, { ...cookie, maxAge: config.SESSION_SECONDS });
        return reply.redirect(flow.rows[0].return_path);
    });
    app.get("/api/auth/session", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const current = await session(request);
        if (!current) return { user: null };
        const user = await pool.query("SELECT profile FROM canvas_users WHERE id=$1", [current.userId]);
        return { user: user.rows[0].profile };
    });
    app.get("/api/account/overview", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const current = await requireSession(request);
        const user = await cachedAccountUser(current);
        const usage = await pool.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM canvas_media WHERE user_id=$1 AND (ready OR expires_at>now())) + (SELECT COALESCE(SUM(octet_length(data::text)),0) FROM canvas_records WHERE user_id=$1 AND NOT deleted) AS bytes", [current.userId]);
        return {
            user,
            storage: { usedBytes: Number(usage.rows[0]?.bytes || 0), quotaBytes: config.USER_STORAGE_BYTES },
            links: { rechargeUrl: new URL("/wallet", config.LLMROAM_URL).href },
        };
    });
    app.post("/api/auth/credentials", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const current = await requireSession(request);
        return (await authorized(current, "/api/oauth-provider/credentials", "POST")).json();
    });
    app.post("/api/auth/revoke-credentials", async (request) => {
        await authorized(await requireSession(request), "/api/oauth-provider/credentials", "DELETE");
        return { success: true };
    });
    app.post("/api/auth/logout", async (request, reply) => {
        const current = await session(request);
        if (current) {
            accountUsers.delete(current.hash);
            await pool.query("DELETE FROM canvas_sessions WHERE id_hash=$1", [current.hash]);
        }
        reply.clearCookie(cookieName, cookie);
        return { success: true };
    });
    return { requireSession };
}
