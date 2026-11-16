import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { challenge, decrypt, digest, encrypt, localReturnPath, randomToken } from "./crypto.js";
import { transaction } from "./db.js";
import { z } from "zod";
import { fail, storageQuota, storageUsage } from "./management.js";
import { isAdminRole, isSuperAdminRole } from "../../shared/roles.js";

const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().nonnegative(), sub: z.string().min(1), authorization_id: z.number().int().positive() });
const profileSchema = z.object({ sub: z.string().min(1), username: z.string(), display_name: z.string(), avatar_url: z.string().optional(), role: z.number().int().nonnegative().default(1), quota: z.number().int().nonnegative().default(0), used_quota: z.number().int().nonnegative().default(0) });
const accountProfileSchema = z.object({ success: z.literal(true), data: profileSchema.omit({ sub: true }).extend({ id: z.number().int().positive() }) });
const walletSettingsSchema = z.object({ success: z.literal(true), data: z.object({ quota_display_type: z.enum(["USD", "CNY", "CUSTOM", "TOKENS"]), quota_per_unit: z.number().positive(), usd_exchange_rate: z.number().positive(), custom_currency_exchange_rate: z.number().positive() }) });
const oauthScope = "api_key:read api_key:write api_key:reveal model_inference:use profile:read wallet:read";
const clientHeaders = { "User-Agent": "InfiniteCanvas" };
export type Credentials = { accessToken: string; refreshToken: string; expiresAt: number; authorizationId: number };
export type Session = { userId: string; hash: string };

export function authService(app: FastifyInstance, pool: Pool, config: Config) {
    const cookie = { httpOnly: true, secure: new URL(config.PUBLIC_URL).protocol === "https:", sameSite: "lax" as const, path: "/" };
    const redirectUri = new URL("/api/auth/callback", config.PUBLIC_URL).href;
    const cookieName = cookie.secure ? "__Host-canvas-session" : "canvas-session";
    const flowCookie = cookie.secure ? "__Host-canvas-flow" : "canvas-flow";
    const accountUsers = new Map<string, { expiresAt: number; value: ReturnType<typeof loadAccountUser> }>();
    const callbackStages = new WeakMap<FastifyRequest, string>();
    async function endSession(request: FastifyRequest, reply: FastifyReply) {
        const raw = request.cookies[cookieName];
        if (raw) {
            const hash = digest(raw);
            accountUsers.delete(hash);
            await pool.query("DELETE FROM canvas_sessions WHERE id_hash=$1", [hash]);
        }
        reply.clearCookie(cookieName, cookie);
    }
    app.addHook("onError", async (request, reply, error) => {
        if (error.statusCode === 401) await endSession(request, reply);
    });
    async function loadAccountUser(current: Session) {
        const { data } = accountProfileSchema.parse(await (await authorized(current, "/api/user/self")).json());
        const profile = { ...data, sub: String(data.id) };
        const balance = await walletBalance(profile);
        const user = { id: current.userId, displayId: profile.sub, username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url || "", ...balance, role: profile.role, isAdmin: isAdminRole(profile.role) };
        await pool.query("UPDATE canvas_users SET profile=$2,profile_updated_at=now() WHERE id=$1", [current.userId,user]);
        return user;
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
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            console.warn("LLMRoam OAuth token request rejected", { grantType: params.get("grant_type"), status: response.status, error: ["invalid_grant", "invalid_client", "invalid_request", "invalid_scope", "temporarily_unavailable", "server_error"].includes(body?.error) ? body.error : "unknown" });
            const expired = response.status === 400 && body?.error === "invalid_grant";
            fail(response.status === 429 ? 429 : expired ? 401 : 502, response.status === 429 ? "LLMRoam 请求过于频繁，请稍后重试" : expired ? "授权凭据已失效，请重新登录" : "LLMRoam 授权服务暂时不可用");
        }
        const result = tokenSchema.safeParse(body);
        if (!result.success) {
            console.warn("LLMRoam OAuth token response invalid", { fields: result.error.issues.map(issue => ({ field: issue.path.join("."), code: issue.code })) });
            throw Object.assign(new Error("LLMRoam 授权响应不符合要求，请更新配套授权服务"), { statusCode: 502, code: "OAUTH_PROVIDER_INCOMPATIBLE" });
        }
        const { access_token, refresh_token, expires_in, sub, authorization_id } = result.data;
        return { sub, accessToken: access_token, refreshToken: refresh_token, expiresAt: Date.now() + expires_in * 1000, authorizationId: authorization_id };
    }
    async function session(request: FastifyRequest): Promise<Session | null> {
        const raw = request.cookies[cookieName];
        if (!raw) return null;
        const hash = digest(raw);
        const result = await pool.query("SELECT s.user_id FROM canvas_sessions s JOIN canvas_users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now() AND u.enabled AND u.oauth_credentials IS NOT NULL", [hash]);
        if (!result.rowCount) return null;
        return { userId: result.rows[0].user_id, hash };
    }
    async function requireSession(request: FastifyRequest) {
        const result = await session(request);
        if (!result) throw Object.assign(new Error("请先登录"), { statusCode: 401 });
        return result;
    }
    async function authorized(session: Session, path: string, method = "GET") {
        // Keep refresh and its provider request under the account lock across browsers and instances.
        let upstreamError: unknown;
        const response = await transaction(pool, async (db) => {
            const result = await db.query("SELECT u.oauth_credentials FROM canvas_users u JOIN canvas_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id_hash=$2 AND s.expires_at>now() AND u.enabled FOR UPDATE OF u", [session.userId, session.hash]);
            if (!result.rowCount) throw Object.assign(new Error("请重新登录"), { statusCode: 401 });
            let value = decrypt<Credentials>(result.rows[0].oauth_credentials, config.ENCRYPTION_KEY);
            if (value.expiresAt <= Date.now()) {
                const refreshed = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: value.refreshToken }));
                if (digest(`${new URL(config.ACCOUNT_ID_ORIGIN).origin}\n${refreshed.sub}`) !== session.userId || refreshed.authorizationId !== value.authorizationId) fail(502, "授权账号不一致");
                value = refreshed;
                await db.query("UPDATE canvas_users SET oauth_credentials=$1 WHERE id=$2", [encrypt(value, config.ENCRYPTION_KEY), session.userId]);
            }
            // A downstream failure must not roll back a successfully rotated refresh token.
            try { return await fetch(new URL(path, config.LLMROAM_URL), { method, headers: { ...clientHeaders, Authorization: `Bearer ${value.accessToken}` } }); }
            catch (error) { upstreamError = error; return null; }
        });
        if (!response) throw upstreamError;
        if (!response.ok) fail(response.status === 429 ? 429 : response.status === 401 ? 401 : response.status === 403 ? 403 : 502, response.status === 429 ? "LLMRoam 请求过于频繁，请稍后重试" : response.status === 401 ? "授权凭据已失效，请重新登录" : "LLMRoam 授权请求失败");
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
    app.get("/api/auth/callback", { errorHandler(error, request, reply) {
        const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500;
        const code = (error as { code?: string }).code;
        const reason = code === "OAUTH_PROVIDER_INCOMPATIBLE" ? "provider_incompatible" : status === 401 ? "invalid_grant" : status === 429 ? "rate_limited" : status >= 500 ? "service_unavailable" : "callback_failed";
        console.warn("Canvas OAuth callback failed", { stage: callbackStages.get(request) || "callback", status, reason, code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined });
        reply.clearCookie(flowCookie, cookie).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        return reply.redirect(`/?auth_error=${reason}`);
    } }, async (request, reply) => {
        callbackStages.set(request, "flow_validation");
        const query = z.object({ state: z.string().min(1), code: z.string().optional(), error: z.string().optional() }).parse(request.query);
        reply.clearCookie(flowCookie, cookie).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        if (query.state !== request.cookies[flowCookie]) fail(400, "登录状态校验失败，请重新登录");
        const flow = await pool.query("DELETE FROM canvas_oauth_flows WHERE state_hash=$1 AND expires_at>now() RETURNING *", [digest(query.state)]);
        if (!flow.rowCount) fail(400, "授权流程已过期或已使用");
        if (query.error || !query.code) {
            const target = new URL(flow.rows[0].return_path, config.PUBLIC_URL);
            target.searchParams.set("auth_error", query.error || "access_denied");
            return reply.redirect(`${target.pathname}${target.search}`);
        }
        callbackStages.set(request, "token_exchange");
        const exchanged = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri, code_verifier: decrypt<string>(flow.rows[0].verifier, config.ENCRYPTION_KEY), reuse_authorization: "true" }));
        const userId = digest(`${new URL(config.ACCOUNT_ID_ORIGIN).origin}\n${exchanged.sub}`);
        const raw = randomToken();
        let callbackFailure: unknown;
        callbackStages.set(request, "account_storage");
        await transaction(pool, async (db) => {
            await db.query("INSERT INTO canvas_users(id,profile) VALUES($1,'{}') ON CONFLICT DO NOTHING", [userId]);
            const saved = await db.query("SELECT enabled,oauth_credentials FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
            if (!saved.rows[0].enabled) fail(403,"此本站账号已被禁用");
            const stored = saved.rows[0].oauth_credentials ? decrypt<Credentials>(saved.rows[0].oauth_credentials, config.ENCRYPTION_KEY) : null;
            // Another browser may have rotated the shared credential after this code exchange.
            let credentials: Credentials = stored?.authorizationId === exchanged.authorizationId ? stored : exchanged;
            if (credentials.expiresAt <= Date.now()) {
                callbackStages.set(request, "token_refresh");
                const refreshed = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }));
                if (refreshed.sub !== exchanged.sub || refreshed.authorizationId !== credentials.authorizationId) fail(502, "授权账号不一致");
                credentials = refreshed;
            }
            callbackStages.set(request, "credential_storage");
            await db.query("UPDATE canvas_users SET oauth_credentials=$2 WHERE id=$1", [userId, encrypt(credentials, config.ENCRYPTION_KEY)]);
            const account = await (async () => {
                callbackStages.set(request, "userinfo");
                const response = await fetch(new URL("/api/oauth-provider/userinfo", config.LLMROAM_URL), { headers: { ...clientHeaders, Authorization: `Bearer ${credentials.accessToken}` } });
                if (!response.ok) fail(response.status === 429 ? 429 : response.status === 401 ? 401 : 502, "无法获取授权用户信息");
                const profile = profileSchema.parse(await response.json());
                if (profile.sub !== exchanged.sub) fail(502, "授权账号不一致");
                callbackStages.set(request, "wallet_settings");
                return { profile, balance: await walletBalance(profile) };
            })().catch(error => { callbackFailure = error; return null; });
            if (!account) return;
            callbackStages.set(request, "session_storage");
            const { profile, balance } = account;
            await db.query("UPDATE canvas_users SET profile=$2,last_login_at=now(),profile_updated_at=now() WHERE id=$1", [userId, { id: userId, displayId: profile.sub, username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url || "", role: profile.role, ...balance }]);
            if (request.cookies[cookieName]) await db.query("DELETE FROM canvas_sessions WHERE id_hash=$1", [digest(request.cookies[cookieName]!)]);
            await db.query("INSERT INTO canvas_sessions(id_hash,user_id,expires_at) VALUES($1,$2,$3)", [digest(raw), userId, new Date(Date.now() + config.SESSION_SECONDS * 1000)]);
        });
        if (callbackFailure) throw callbackFailure;
        reply.setCookie(cookieName, raw, { ...cookie, maxAge: config.SESSION_SECONDS });
        return reply.redirect(flow.rows[0].return_path);
    });
    app.get("/api/auth/session", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const current = await session(request);
        if (!current) { await endSession(request, reply); return { user: null }; }
        const user = (await pool.query("SELECT profile,oauth_credentials FROM canvas_users WHERE id=$1", [current.userId])).rows[0];
        return { user: { ...user.profile, authorizationId: decrypt<Credentials>(user.oauth_credentials, config.ENCRYPTION_KEY).authorizationId } };
    });
    app.get("/api/account/overview", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const current = await requireSession(request);
        const user = await cachedAccountUser(current);
        const [usedBytes,quotaBytes] = await Promise.all([storageUsage(pool,current.userId),storageQuota(pool,config,current.userId)]);
        return {
            user,
            storage: { usedBytes, quotaBytes },
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
        await endSession(request, reply);
        return { success: true };
    });
    async function requireAdmin(request: FastifyRequest) {
        const current = await requireSession(request);
        // Permissions are checked against the provider for every admin request, independently of the wallet cache.
        const profile = accountProfileSchema.parse(await (await authorized(current,"/api/user/self")).json()).data;
        if (!isAdminRole(profile.role)) fail(403,"需要管理员权限");
        return current;
    }
    async function requireSuperAdmin(request: FastifyRequest) {
        const current = await requireSession(request);
        const profile = accountProfileSchema.parse(await (await authorized(current,"/api/user/self")).json()).data;
        if (!isSuperAdminRole(profile.role)) fail(403,"需要超级管理员权限");
        return current;
    }
    return { requireSession, requireAdmin, requireSuperAdmin };
}
