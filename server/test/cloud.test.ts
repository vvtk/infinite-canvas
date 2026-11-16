import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { challenge, decrypt, digest, encrypt, localReturnPath } from "../src/crypto.js";
import {syncSource} from "../src/prompt-sync.js";
import type { Credentials } from "../src/auth.js";
import type { WorkflowDocument } from "../../shared/tutorial-workflow.js";

test("authenticated encryption rejects tampering and return paths stay local", () => {
    const key = randomBytes(32).toString("hex");
    const encrypted = encrypt({ token: "secret" }, key);
    assert.deepEqual(decrypt(encrypted, key), { token: "secret" });
    const buffer = Buffer.from(encrypted, "base64"); buffer[20] ^= 1;
    assert.throws(() => decrypt(buffer.toString("base64"), key));
    for (const path of ["//evil.invalid/", "/\\evil.invalid/", "https://evil.invalid/", "/api/auth/logout"]) assert.equal(localReturnPath(path), "/");
    assert.equal(localReturnPath("/canvas/abc?test=1"), "/canvas/abc?test=1");
});

test("account identity can stay pinned when the provider connection switches to HTTPS", () => {
    const env = { PUBLIC_URL: "http://localhost:3000", LLMROAM_URL: "https://www.llmroam.com", OAUTH_CLIENT_ID: "canvas", OAUTH_CLIENT_SECRET: "s".repeat(32), DATABASE_URL: "postgres://fixture", ENCRYPTION_KEY: "a".repeat(64) };
    assert.equal(readConfig(env).ACCOUNT_ID_ORIGIN, env.LLMROAM_URL);
    const config = readConfig({ ...env, ACCOUNT_ID_ORIGIN: "http://www.llmroam.com" });
    assert.equal(config.ACCOUNT_ID_ORIGIN, "http://www.llmroam.com");
    assert.equal(config.OAUTH_AUTHORIZE_URL, "https://www.llmroam.com/api/oauth-provider/authorize");
    assert.throws(() => readConfig({ ...env, ACCOUNT_ID_ORIGIN: "https://www.llmroam.com/unexpected-path" }));
});

test("PostgreSQL auth, isolation, revision conflicts, media quota", { skip: !process.env.TEST_DATABASE_URL }, async (suite) => {
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    await migrate(pool);
    await pool.query("TRUNCATE canvas_system_channel,canvas_admin_audit,canvas_ai_requests,canvas_library,canvas_prompt_sources,canvas_public_media,canvas_site_settings,canvas_media,canvas_records,canvas_sessions,canvas_oauth_flows,canvas_users CASCADE");
    await pool.query("TRUNCATE canvas_storage_restore_previews,canvas_storage_task_items,canvas_storage_tasks,canvas_storage_backups,canvas_storage_policy,canvas_storage_pools CASCADE");
    await pool.query("INSERT INTO canvas_storage_policy(id) VALUES(true)");
    const codes = new Map<string, { challenge: string; user: string }>();
    const walletSettings = { quota_display_type: "CUSTOM", quota_per_unit: 500000, usd_exchange_rate: 7, custom_currency_exchange_rate: 10 };
    let adminRole=100;
    let accountStatus = 200;
    let accountRequests = 0;
    let walletSettingsRequests = 0;
    let tokenStatus = 200;
    let tokenError = "temporarily_unavailable";
    let tokenIdentity: Record<string, unknown> | null = null;
    let refreshRequests = 0;
    const refreshOwners = new Map<string, string>();
    const currentRefresh = new Map<string, string>();
    const subject = (user: string) => user === "alice" ? "1" : user === "bob" ? "2" : user === "admin" ? "4" : "3";
    let provider: Server;
    provider = createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/status") {
            walletSettingsRequests++;
            return response.end(JSON.stringify({ success: true, data: walletSettings }));
        }
        if (request.url === "/api/user/self") {
            accountRequests++;
            response.statusCode = accountStatus;
            if (accountStatus !== 200) return response.end();
            const user = request.headers.authorization?.replace("Bearer ", "");
            return response.end(JSON.stringify({ success: true, data: { id: user === "alice" ? 1 : user === "admin" ? 4 : 2, role:user === "admin" ? adminRole : 1, username: user, display_name: user, quota: 76089291, used_quota: 500000 } }));
        }
        if (request.url === "/api/oauth-provider/token") {
            let body = ""; for await (const chunk of request) body += chunk;
            const params = new URLSearchParams(body);
            if (tokenStatus !== 200) { response.statusCode = tokenStatus; return response.end(JSON.stringify({ error: tokenError })); }
            if (params.get("grant_type") === "refresh_token") {
                const previous = params.get("refresh_token") || "";
                const user = refreshOwners.get(previous);
                if (!user) { response.statusCode = 400; return response.end(JSON.stringify({ error: "invalid_grant" })); }
                refreshOwners.delete(previous);
                const refresh = `refresh-${user}-${++refreshRequests}`;
                refreshOwners.set(refresh, user); currentRefresh.set(user, refresh);
                return response.end(JSON.stringify({ access_token: user, refresh_token: refresh, expires_in: 3600, ...(tokenIdentity || { sub: subject(user), authorization_id: Number(subject(user)) }) }));
            }
            const grant = codes.get(params.get("code") || "");
            if (!grant || grant.challenge !== challenge(params.get("code_verifier") || "")) { response.statusCode = 400; return response.end("{}"); }
            codes.delete(params.get("code")!);
            const refresh = currentRefresh.get(grant.user) || `refresh-${grant.user}`;
            currentRefresh.set(grant.user, refresh); refreshOwners.set(refresh, grant.user);
            return response.end(JSON.stringify({ access_token: grant.user, refresh_token: refresh, expires_in: 3600, ...(tokenIdentity || { sub: subject(grant.user), authorization_id: Number(subject(grant.user)) }) }));
        }
        if (request.url === "/api/oauth-provider/userinfo") {
            const user = request.headers.authorization?.replace("Bearer ", "");
            return response.end(JSON.stringify({ sub: user === "alice" ? "1" : user === "bob" ? "2" : user === "admin" ? "4" : "3", role:user === "admin" ? adminRole : 1, username: user, display_name: user, avatar_url: "", quota: 76089291, used_quota: 500000 }));
        }
        if (request.url === "/api/oauth-provider/credentials") return response.end(JSON.stringify({ apiKey: "sk-test", baseUrl: "http://localhost:33002" }));
        response.statusCode = 404; response.end("{}");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as { port: number }).port;
    const config = readConfig({ PUBLIC_URL: "http://localhost:3000", LLMROAM_URL: `http://127.0.0.1:${providerPort}`, OAUTH_CLIENT_ID: "canvas", OAUTH_CLIENT_SECRET: "s".repeat(32), DATABASE_URL: process.env.TEST_DATABASE_URL!, ENCRYPTION_KEY: randomBytes(32).toString("hex"), S3_ENDPOINT: "http://localhost:9000", S3_PUBLIC_ENDPOINT: "http://localhost:9000", S3_REGION: "us-east-1", S3_BUCKET: "canvas", S3_ACCESS_KEY: "test", S3_SECRET_KEY: "test-secret", MAX_MEDIA_BYTES: "8", USER_STORAGE_BYTES: "12" });
    config.ACCOUNT_ID_ORIGIN = "http://previous-provider.test";
        config.USER_STORAGE_BYTES = 2147483648;
        if (process.env.TEST_S3_ENDPOINT) {
            config.S3_ENDPOINT = config.S3_PUBLIC_ENDPOINT = process.env.TEST_S3_ENDPOINT;
            config.S3_ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY!;
            config.S3_SECRET_KEY = process.env.TEST_S3_SECRET_KEY!;
            const s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } });
            try { await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET })); }
            catch (error) { if ((error as { name: string }).name !== "BucketAlreadyOwnedByYou") throw error; }
            finally { s3.destroy(); }
        }
        await pool.query("DELETE FROM canvas_site_settings");
        await pool.query("INSERT INTO canvas_site_settings(id,data) VALUES(true,$1)",[JSON.stringify({siteName:"测试画布",description:"",logoUrl:"",announcement:"",publicContent:{prompts:true,tutorials:true,skills:true,assets:true},defaultStorageBytes:config.USER_STORAGE_BYTES,promptSyncMinutes:0})]);
        const app = await createApp(config, pool);
    async function begin(user: string) {
        const login = await app.inject({ url: "/api/auth/login?returnTo=/canvas" });
        assert.equal(login.statusCode, 302);
        const authorize = new URL(login.headers.location!);
        const cookie = `canvas-flow=${login.cookies.find((item) => item.name === "canvas-flow")!.value}`;
        const code = randomBytes(12).toString("hex");
        codes.set(code, { challenge: authorize.searchParams.get("code_challenge")!, user });
        return { cookie, url: `/api/auth/callback?state=${authorize.searchParams.get("state")}&code=${code}` };
    }
    async function login(user: string) {
        const flow = await begin(user);
        const result = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
        assert.equal(result.statusCode, 302, result.body);
        assert.equal(result.headers.location, "/canvas");
        return `canvas-session=${result.cookies.find((item) => item.name === "canvas-session")!.value}`;
    }
    try {
        await suite.test("callback state binding, one-use flows and encrypted credentials", async () => {
            const flow = await begin("state-user");
            const mismatch = await app.inject({ url: flow.url, headers: { cookie: "canvas-flow=wrong" } });
            assert.equal(mismatch.statusCode, 302);
            assert.equal(mismatch.headers.location, "/?auth_error=callback_failed");
            const result = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
            assert.equal(result.statusCode, 302, result.body);
            const replay = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
            assert.equal(replay.statusCode, 302);
            assert.equal(replay.headers.location, "/?auth_error=callback_failed");
            const rows = await pool.query("SELECT oauth_credentials FROM canvas_users");
            assert.ok(!rows.rows[0].oauth_credentials.includes("state-user"));
            assert.equal(decrypt<Credentials>(rows.rows[0].oauth_credentials, config.ENCRYPTION_KEY).accessToken, "state-user");
        });
        await suite.test("login and refresh retain the configured account identity origin", async () => {
            const cookie = await login("alice"), userId = digest(`${config.ACCOUNT_ID_ORIGIN}\n1`);
            const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
            assert.equal(session.json().user.id, userId);
            const row = (await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [userId])).rows[0];
            const credentials = decrypt<Credentials>(row.oauth_credentials, config.ENCRYPTION_KEY);
            await pool.query("UPDATE canvas_users SET oauth_credentials=$2 WHERE id=$1", [userId, encrypt({ ...credentials, expiresAt: 0 }, config.ENCRYPTION_KEY)]);
            const refreshed = await app.inject({ url: "/api/account/overview", headers: { cookie } });
            assert.equal(refreshed.statusCode, 200, refreshed.body);
            assert.equal(refreshed.json().user.id, userId);
        });
        await suite.test("callback failures return home without exposing authorization secrets", async () => {
            const malformed = await app.inject({ url: "/api/auth/callback" });
            assert.equal(malformed.statusCode, 302);
            assert.equal(malformed.headers.location, "/?auth_error=callback_failed");
            for (const [status, error, reason] of [[400, "invalid_grant", "invalid_grant"], [401, "invalid_client", "service_unavailable"], [429, "temporarily_unavailable", "rate_limited"], [503, "server_error", "service_unavailable"]] as const) {
                const sessionCookie = await login("callback-user");
                const flow = await begin("callback-user");
                try {
                    tokenStatus = status; tokenError = error;
                    const result = await app.inject({ url: flow.url, headers: { cookie: `${sessionCookie}; ${flow.cookie}` } });
                    assert.equal(result.statusCode, 302);
                    assert.equal(result.headers.location, `/?auth_error=${reason}`);
                    assert.equal(result.headers["cache-control"], "no-store");
                    assert.equal(result.headers["referrer-policy"], "no-referrer");
                    assert.equal(result.cookies.find(item => item.name === "canvas-flow")?.value, "");
                    const current = await app.inject({ url: "/api/auth/session", headers: { cookie: sessionCookie } });
                    assert.equal(Boolean(current.json().user), error !== "invalid_grant");
                } finally { tokenStatus = 200; }
            }
        });
        await suite.test("incompatible token identity rejects login without replacing credentials or creating an account", async () => {
            const sessionCookie = await login("alice"), userId = digest(`${config.ACCOUNT_ID_ORIGIN}\n1`);
            const saved = (await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [userId])).rows[0].oauth_credentials;
            const count = (await pool.query("SELECT count(*) FROM canvas_users")).rows[0].count;
            for (const identity of [{}, { sub: 1, authorization_id: "1" }, { sub: "1", authorization_id: 0 }]) {
                const flow = await begin("alice");
                try {
                    tokenIdentity = identity;
                    const result = await app.inject({ url: flow.url, headers: { cookie: `${sessionCookie}; ${flow.cookie}` } });
                    assert.equal(result.headers.location, "/?auth_error=provider_incompatible");
                    assert.equal(result.cookies.some(item => item.name === "canvas-session"), false);
                    assert.equal(result.headers["cache-control"], "no-store");
                    assert.equal(result.headers["referrer-policy"], "no-referrer");
                    assert.equal((await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [userId])).rows[0].oauth_credentials, saved);
                    assert.equal((await pool.query("SELECT count(*) FROM canvas_users")).rows[0].count, count);
                    assert.equal((await app.inject({ url: "/api/auth/session", headers: { cookie: sessionCookie } })).json().user.id, userId);
                } finally { tokenIdentity = null; }
            }
        });
        const first = await login("alice"); const second = await login("bob");
        const headers = { cookie: first, origin: config.PUBLIC_URL };
        const record = { domain: "canvas", id: "shared-id", baseRevision: 0, deleted: false, data: { id: "shared-id", title: "First" }, media: [] };
        await suite.test("authentication and CSRF fail closed", async () => {
            assert.equal((await app.inject({ url: "/api/sync/changes" })).statusCode, 401);
            assert.equal((await app.inject({ url: "/api/account/overview" })).statusCode, 401);
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers: { cookie: first, origin: "https://evil.invalid" }, payload: record })).statusCode, 403);
        });
        await suite.test("account overview uses the session user and storage quota", async () => {
            const overview = await app.inject({ url: "/api/account/overview", headers });
            assert.equal(overview.statusCode, 200, overview.body);
            assert.equal(overview.json().user.displayId, "1");
            assert.equal(overview.json().user.isAdmin, false);
            assert.equal(overview.json().user.points, 76089291 / 500000 * 10);
            assert.equal(overview.json().user.usedPoints, 10);
            const session = await app.inject({ url: "/api/auth/session", headers });
            assert.equal(session.json().user.points, overview.json().user.points);
            assert.equal(session.json().user.usedPoints, 10);
            assert.equal(overview.json().storage.quotaBytes, config.USER_STORAGE_BYTES);
            assert.equal(new URL(overview.json().links.rechargeUrl).pathname, "/wallet");
        });
        await suite.test("wallet conversion follows the provider display settings", async () => {
            try {
                for (const [displayType, expected] of [["USD", 76089291 / 500000], ["CNY", 76089291 / 500000 * 7], ["TOKENS", 76089291]] as const) {
                    walletSettings.quota_display_type = displayType;
                    const overview = await app.inject({ url: "/api/account/overview", headers: { cookie: await login("alice") } });
                    assert.equal(overview.statusCode, 200, overview.body);
                    assert.equal(overview.json().user.points, expected);
                }
                walletSettings.quota_display_type = "CUSTOM";
                walletSettings.custom_currency_exchange_rate = 20;
                const overview = await app.inject({ url: "/api/account/overview", headers: { cookie: await login("alice") } });
                assert.equal(overview.json().user.points, 76089291 / 500000 * 20);
            } finally {
                walletSettings.quota_display_type = "CUSTOM";
                walletSettings.custom_currency_exchange_rate = 10;
            }
        });
        await suite.test("account rate limits keep their status and actionable message", async () => {
            const rateLimitHeaders = { cookie: await login("alice") };
            accountStatus = 429;
            try {
                const overview = await app.inject({ url: "/api/account/overview", headers: rateLimitHeaders });
                assert.equal(overview.statusCode, 429);
                assert.equal(overview.json().message, "LLMRoam 请求过于频繁，请稍后重试");
            } finally { accountStatus = 200; }
            assert.equal((await app.inject({ url: "/api/account/overview", headers: rateLimitHeaders })).statusCode, 200);
        });
        await suite.test("account cache merges concurrent requests, expires after five minutes and isolates sessions", async (context) => {
            let now = Date.now();
            context.mock.method(Date, "now", () => now);
            const cacheHeaders = { cookie: await login("alice") };
            const otherHeaders = { cookie: await login("bob") };
            const initialRequests = accountRequests;
            const initialSettingsRequests = walletSettingsRequests;
            const responses = await Promise.all([1, 2, 3].map(() => app.inject({ url: "/api/account/overview", headers: cacheHeaders })));
            for (const response of responses) assert.equal(response.statusCode, 200, response.body);
            assert.equal(accountRequests, initialRequests + 1);
            assert.equal(walletSettingsRequests, initialSettingsRequests + 1);
            now += 5 * 60 * 1000 - 1;
            assert.equal((await app.inject({ url: "/api/account/overview", headers: cacheHeaders })).statusCode, 200);
            assert.equal(accountRequests, initialRequests + 1);
            now++;
            assert.equal((await app.inject({ url: "/api/account/overview", headers: cacheHeaders })).statusCode, 200);
            assert.equal(accountRequests, initialRequests + 2);
            const other = await app.inject({ url: "/api/account/overview", headers: otherHeaders });
            assert.equal(other.json().user.displayId, "2");
            assert.equal(accountRequests, initialRequests + 3);
        });
        await suite.test("concurrent writes have exactly one winner; records isolate users", async () => {
            const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/sync/records", headers, payload: record })));
            assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 409]);
            const privateChanges = await app.inject({ url: "/api/sync/changes", headers: { cookie: second } });
            assert.deepEqual(privateChanges.json().records, []);
            const changes = (await app.inject({ url: "/api/sync/changes", headers })).json();
            assert.equal(changes.records.length, 1);
            assert.equal(changes.records[0].revision, 1);
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers, payload: { ...record, baseRevision: 1, deleted: true, data: null } })).statusCode, 200);
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers, payload: { ...record, baseRevision: 1 } })).statusCode, 409);
            assert.equal((await app.inject({ url: "/api/sync/changes?cursor=1", headers })).json().records[0].deleted, true);
        });
        await suite.test("secrets and references to another user's media are rejected", async () => {
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers, payload: { ...record, id: "secret", data: { id: "secret", nested: { apiKey: "secret" } } } })).statusCode, 400);
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers, payload: { ...record, id: "media", data: { id: "media" }, media: ["not-owned"] } })).statusCode, 400);
        });
        await suite.test("real S3 signed POST, checksum completion and private download", { skip: !process.env.TEST_S3_ENDPOINT }, async () => {
            const bytes = new Uint8Array([1, 2, 3, 4]);
            const sha256 = digest(Buffer.from(bytes));
            const upload = await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload: { storageKey: "image:real", bytes: bytes.length, mimeType: "image/png", sha256 } });
            assert.equal(upload.statusCode, 200, upload.body);
            const { id, upload: signed } = upload.json();
            const body = new FormData();
            for (const [key, value] of Object.entries(signed.fields)) body.append(key, String(value));
            body.append("file", new Blob([bytes], { type: "image/png" }));
            const response = await fetch(signed.url, { method: "POST", body });
            assert.ok(response.ok, await response.text());
            const complete = await app.inject({ method: "POST", url: `/api/media/${id}/complete`, headers, payload: {} });
            assert.equal(complete.statusCode, 200, complete.body);
            assert.equal((await app.inject({ url: `/api/media/${id}/url`, headers: { cookie: second } })).statusCode, 404);
            const url = (await app.inject({ url: `/api/media/${id}/url`, headers })).json().url;
            const downloaded = await fetch(url);
            assert.ok(downloaded.ok);
            assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
        });
        await suite.test("signed upload is bounded, quota reservations serialize, media ownership enforced", async () => {
            config.USER_STORAGE_BYTES = process.env.TEST_S3_ENDPOINT ? 16 : 12;
            await pool.query("UPDATE canvas_site_settings SET data=jsonb_set(data,'{defaultStorageBytes}',$1::jsonb)",[JSON.stringify(config.USER_STORAGE_BYTES)]);
            const payload = { storageKey: "image:one", bytes: 8, mimeType: "image/png", sha256: "a".repeat(64) };
            const upload = await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload });
            assert.equal(upload.statusCode, 200, upload.body);
            const policy = JSON.parse(Buffer.from(upload.json().upload.fields.Policy, "base64").toString());
            assert.ok(policy.conditions.some((condition: unknown[]) => Array.isArray(condition) && condition[0] === "content-length-range" && condition[1] === 8 && condition[2] === 8));
            assert.equal((await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload: { ...payload, storageKey: "image:two" } })).statusCode, 413);
            assert.equal((await app.inject({ url: `/api/media/${upload.json().id}/url`, headers: { cookie: second } })).statusCode, 404);
            assert.equal((await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload: { ...payload, bytes: 9 } })).statusCode, 400);
        });
        const adminHeaders={cookie:await login("admin"),origin:config.PUBLIC_URL};
        const adminId=(await app.inject({url:"/api/auth/session",headers:adminHeaders})).json().user.id;
        const bobId=(await app.inject({url:"/api/auth/session",headers:{cookie:second}})).json().user.id;
        await suite.test("private-channel visibility is public, administrator-controlled, revisioned and audited", async () => {
            const url = "/api/admin/settings";
            const snapshot = (await app.inject({ url, headers: adminHeaders })).json();
            assert.equal((await app.inject({ url: "/api/library/settings" })).json().hidePrivateChannels, false);
            snapshot.data.hidePrivateChannels = true;
            assert.equal((await app.inject({ method: "PATCH", url, headers, payload: snapshot })).statusCode, 403);
            assert.equal((await app.inject({ method: "PATCH", url, headers: adminHeaders, payload: snapshot })).statusCode, 200);
            assert.equal((await app.inject({ method: "PATCH", url, headers: adminHeaders, payload: snapshot })).statusCode, 409);
            assert.equal((await app.inject({ url: "/api/library/settings" })).json().hidePrivateChannels, true);
            assert.ok((await pool.query("SELECT 1 FROM canvas_admin_audit WHERE action='settings.update' AND summary->>'hidePrivateChannels'='true'")).rowCount);
        });
        await suite.test("all admin modules require live provider permission",async()=>{
            for(const path of ["session","users","settings","audit","compute-logs","ai-logs","prompts","tutorials","skills","assets","prompt-sources","system-channel"]){
                assert.equal((await app.inject({url:`/api/admin/${path}`})).statusCode,401,path);
                assert.equal((await app.inject({url:`/api/admin/${path}`,headers})).statusCode,403,path);
                assert.equal((await app.inject({url:`/api/admin/${path}`,headers:adminHeaders})).statusCode,200,path);
            }
            for(const path of ["prompts","tutorials","skills","assets","prompt-sources","media/uploads"])
                assert.equal((await app.inject({method:"POST",url:`/api/admin/${path}`,headers,payload:{}})).statusCode,403,path);
            adminRole=1;
            assert.equal((await app.inject({url:"/api/admin/users",headers:adminHeaders})).statusCode,403);
            adminRole=10;
            assert.equal((await app.inject({url:"/api/admin/users",headers:adminHeaders})).statusCode,200);
            for(const path of ["settings","storage/pools","system-channel"])
                assert.equal((await app.inject({url:`/api/admin/${path}`,headers:adminHeaders})).statusCode,403,path);
            for(const request of [
                { method:"PATCH", url:"/api/admin/settings" },
                { method:"PATCH", url:"/api/admin/system-channel" },
                { method:"POST", url:"/api/admin/storage/pools" },
                { method:"DELETE", url:"/api/admin/storage/pools/unknown" },
            ]) assert.equal((await app.inject({ ...request, headers:adminHeaders, payload:{} })).statusCode,403,request.url);
            adminRole=100;
        });
        await suite.test("system channel writes use live admin permission, revisions and audit; account reads expose only enabled models", async () => {
            assert.equal((await app.inject({ url: "/api/system-channel" })).statusCode, 401);
            const snapshot = (await app.inject({ url: "/api/admin/system-channel", headers: adminHeaders })).json();
            assert.deepEqual(snapshot.data.models, []);
            snapshot.data.models = [{ name: "available", capability: "image", script: "return [];" }, { name: "hidden", capability: "text" }];
            snapshot.data.enabledModels = ["available"];
            snapshot.data.defaults.imageModel = "available";
            const patch = (requestHeaders: typeof adminHeaders) => app.inject({ method: "PATCH", url: "/api/admin/system-channel", headers: requestHeaders, payload: snapshot });
            assert.equal((await patch(headers)).statusCode, 403);
            adminRole = 1;
            try { assert.equal((await patch(adminHeaders)).statusCode, 403); }
            finally { adminRole = 100; }
            assert.equal((await patch(adminHeaders)).statusCode, 200);
            assert.equal((await patch(adminHeaders)).statusCode, 409);
            const readable = (await app.inject({ url: "/api/system-channel", headers })).json();
            assert.deepEqual(readable.data.models.map((model: { name: string }) => model.name), ["available"]);
            assert.equal(readable.revision, snapshot.revision + 1);
            assert.ok(!JSON.stringify(readable).includes("sk-test"));
            assert.ok((await pool.query("SELECT 1 FROM canvas_admin_audit WHERE action='system-channel.update' AND actor_id=$1", [adminId])).rowCount);
        });
        await suite.test("cloud storage switch blocks private reads and writes without revoking login or admin access",async()=>{
            const settings=(await app.inject({url:"/api/admin/settings",headers:adminHeaders})).json();
            settings.data.userCloudStorageEnabled=false;
            assert.equal((await app.inject({method:"PATCH",url:"/api/admin/settings",headers:adminHeaders,payload:settings})).statusCode,200);
            try {
                assert.equal((await app.inject({url:"/api/library/settings"})).json().userCloudStorageEnabled,false);
                const requests=[
                    app.inject({url:"/api/sync/changes",headers}),
                    app.inject({url:"/api/media/unknown/url",headers}),
                    app.inject({method:"POST",url:"/api/sync/records",headers,payload:{domain:"canvas",id:"disabled-test",data:{id:"disabled-test"},baseRevision:0,deleted:false,media:[]}}),
                    app.inject({method:"POST",url:"/api/media/uploads",headers,payload:{storageKey:"image:disabled-test",bytes:1,mimeType:"image/png",sha256:digest(Buffer.from([1]))}}),
                    app.inject({method:"POST",url:"/api/media/unknown/complete",headers,payload:{}}),
                ];
                for(const response of await Promise.all(requests)){assert.equal(response.statusCode,403,response.body);assert.equal(response.json().code,"CLOUD_STORAGE_DISABLED");}
                assert.ok((await app.inject({url:"/api/auth/session",headers})).json().user);
                assert.equal((await app.inject({url:"/api/admin/storage/pools",headers:adminHeaders})).statusCode,200);
                assert.equal((await app.inject({url:"/api/admin/storage/pools",headers})).statusCode,403);
                assert.equal((await pool.query("SELECT 1 FROM canvas_records WHERE id='disabled-test'")).rowCount,0);
            } finally {
                settings.revision++;settings.data.userCloudStorageEnabled=true;
                assert.equal((await app.inject({method:"PATCH",url:"/api/admin/settings",headers:adminHeaders,payload:settings})).statusCode,200);
            }
            assert.equal((await app.inject({url:"/api/sync/changes",headers})).statusCode,200);
        });
        await suite.test("disabling users clears sessions, blocks login, prevents self-disable",async()=>{
            const update=(id:string,enabled:boolean)=>app.inject({method:"PATCH",url:`/api/admin/users/${id}`,headers:adminHeaders,payload:{enabled,note:"测试备注",storageBytes:null}});
            assert.equal((await update(adminId,false)).statusCode,400);
            assert.equal((await update(bobId,false)).statusCode,200);
            assert.equal((await app.inject({url:"/api/sync/changes",headers:{cookie:second}})).statusCode,401);
            const flow=await begin("bob");
            const disabled = await app.inject({url:flow.url,headers:{cookie:flow.cookie}});
            assert.equal(disabled.statusCode,302);
            assert.equal(disabled.headers.location,"/?auth_error=callback_failed");
            assert.equal((await update(bobId,true)).statusCode,200);
            assert.equal((await app.inject({url:"/api/sync/changes",headers:{cookie:second}})).statusCode,401);
            const fresh=await login("bob");
            assert.equal((await app.inject({method:"POST",url:`/api/admin/users/${bobId}/revoke-sessions`,headers:adminHeaders,payload:{}})).statusCode,200);
            assert.equal((await app.inject({url:"/api/sync/changes",headers:{cookie:fresh}})).statusCode,401);
        });
        await suite.test("public resources expose only published and enabled content to independent readers",async()=>{
            for(const [kind,data] of Object.entries({prompts:{title:"Public prompt",prompt:"正文"},tutorials:{title:"Public tutorial",format:"markdown",content:"# 正文"},skills:{title:"Public skill",name:"public-skill",description:"说明",instructions:"正文"},assets:{title:"Public text",assetKind:"text",content:"素材正文"}})){
                const create=await app.inject({method:"POST",url:`/api/admin/${kind}`,headers:adminHeaders,payload:{data,published:false,position:0}});
                assert.equal(create.statusCode,200,create.body);const {id}=create.json();
                assert.equal((await app.inject({url:`/api/library/${kind}/${id}`})).statusCode,404);
                assert.equal((await app.inject({method:"PATCH",url:`/api/admin/${kind}/${id}`,headers:adminHeaders,payload:{data,published:true,position:0,revision:1}})).statusCode,200);
                const firstReader=await app.inject({url:`/api/library/${kind}/${id}`});
                const secondReader=await app.inject({url:`/api/library/${kind}/${id}`,headers:{cookie:headers.cookie}});
                assert.deepEqual(firstReader.json(),secondReader.json());
                assert.equal(firstReader.json().data.title,data.title);
                const settings=(await app.inject({url:"/api/admin/settings",headers:adminHeaders})).json();
                settings.data.publicContent[kind]=false;
                assert.equal((await app.inject({method:"PATCH",url:"/api/admin/settings",headers:adminHeaders,payload:settings})).statusCode,200);
                assert.equal((await app.inject({url:`/api/library/${kind}/${id}`})).statusCode,404);
                settings.revision++;settings.data.publicContent[kind]=true;
                assert.equal((await app.inject({method:"PATCH",url:"/api/admin/settings",headers:adminHeaders,payload:settings})).statusCode,200);
                assert.equal((await app.inject({method:"POST",url:`/api/admin/${kind}/delete`,headers:adminHeaders,payload:{ids:[id]}})).statusCode,200);
                assert.equal((await app.inject({url:`/api/library/${kind}/${id}`})).statusCode,404);
            }
        });
        await suite.test("workflow tutorial details enforce permissions, publication, summary lists and revisions", async () => {
            const workflow: WorkflowDocument = { version: 1, nodes: [{ id: "text", type: "text", title: "文本", width: 200, height: 120, position: { x: 10, y: 20 }, metadata: { prompt: "手动生成", status: "idle" } }], connections: [], models: { text: { name: "text-model", capability: "text" } }, media: [] };
            const data = { title: "Workflow fixture", format: "workflow", workflow };
            const create = await app.inject({ method: "POST", url: "/api/admin/tutorials", headers: adminHeaders, payload: { data, published: false } });
            assert.equal(create.statusCode, 200, create.body);
            const { id } = create.json(), detailUrl = `/api/admin/tutorials/${id}`, publicUrl = `/api/library/tutorials/${id}`;
            assert.equal((await app.inject({ url: detailUrl })).statusCode, 401);
            assert.equal((await app.inject({ url: detailUrl, headers })).statusCode, 403);
            assert.deepEqual((await app.inject({ url: detailUrl, headers: adminHeaders })).json().data.workflow, workflow);
            assert.equal((await app.inject({ url: publicUrl })).statusCode, 404);
            const patch = (revision: number, published = true) => app.inject({ method: "PATCH", url: detailUrl, headers: adminHeaders, payload: { data, published, revision } });
            assert.equal((await patch(1)).statusCode, 200);
            assert.equal((await patch(1)).statusCode, 409);
            assert.equal((await app.inject({ url: detailUrl, headers: adminHeaders })).json().revision, 2);
            assert.deepEqual((await app.inject({ url: publicUrl })).json().data.workflow, workflow);
            for (const url of ["/api/library/tutorials?keyword=Workflow%20fixture", "/api/admin/tutorials?keyword=Workflow%20fixture"]) {
                const list = (await app.inject({ url, headers: adminHeaders })).json();
                const item = list.items.find((entry: { id: string }) => entry.id === id);
                assert.equal(item.data.workflow, undefined);
                assert.deepEqual(item.data.workflowSummary, { nodeCount: 1, connectionCount: 0 });
            }
            workflow.nodes[0].metadata!.prompt = "更新后的提示词";
            assert.equal((await patch(2)).statusCode, 200);
            assert.equal((await app.inject({ url: publicUrl })).json().data.workflow.nodes[0].metadata.prompt, "更新后的提示词");
            assert.equal((await patch(3, false)).statusCode, 200);
            assert.equal((await app.inject({ url: publicUrl })).statusCode, 404);
            assert.equal((await app.inject({ url: detailUrl, headers: adminHeaders })).statusCode, 200);
            const broken = structuredClone(workflow); broken.connections = [{ id: "bad", fromNodeId: "text", toNodeId: "missing" }];
            const invalid = await app.inject({ method: "PATCH", url: detailUrl, headers: adminHeaders, payload: { data: { ...data, workflow: broken }, published: true, revision: 4 } });
            assert.equal(invalid.statusCode, 400); assert.match(invalid.json().message, /不存在的节点/);
            assert.equal((await app.inject({ url: detailUrl, headers: adminHeaders })).json().revision, 4);
            assert.equal((await app.inject({ method: "POST", url: "/api/admin/tutorials/delete", headers: adminHeaders, payload: { ids: [id] } })).statusCode, 200);
            assert.equal((await app.inject({ url: detailUrl, headers: adminHeaders })).statusCode, 404);
        });
        await suite.test("workflow sidebar filters before pagination and includes unpublished administrator summaries", async () => {
            const workflow: WorkflowDocument = { version: 1, nodes: [{ id: "text", type: "text", title: "文本", width: 200, height: 120, position: { x: 0, y: 0 } }], connections: [], models: {}, media: [] };
            const keyword = "Workflow sidebar fixture", ids: string[] = [];
            try {
                for (const [position, format] of ["markdown", "workflow", "link", "workflow"].entries()) {
                    const data = { title: `${keyword} ${position}`, format, ...(format === "workflow" ? { workflow } : format === "link" ? { href: "/prompts" } : { content: "普通教程" }) };
                    const created = await app.inject({ method: "POST", url: "/api/admin/tutorials", headers: adminHeaders, payload: { data, position, published: position !== 3 } });
                    assert.equal(created.statusCode, 200, created.body);
                    ids.push(created.json().id);
                }
                const url = `/api/admin/tutorials?format=workflow&keyword=${encodeURIComponent(keyword)}&pageSize=1`;
                assert.equal((await app.inject({ url })).statusCode, 401);
                assert.equal((await app.inject({ url, headers })).statusCode, 403);
                for (const page of [1, 2]) {
                    const response = await app.inject({ url: `${url}&page=${page}`, headers: adminHeaders });
                    assert.equal(response.statusCode, 200, response.body);
                    const list = response.json();
                    assert.equal(list.total, 2); assert.equal(list.items.length, 1);
                    assert.equal(list.items[0].id, ids[page * 2 - 1]);
                    assert.equal(list.items[0].published, page === 1);
                    assert.equal(list.items[0].data.format, "workflow");
                    assert.equal(list.items[0].data.workflow, undefined);
                    assert.deepEqual(list.items[0].data.workflowSummary, { nodeCount: 1, connectionCount: 0 });
                }
                const beyond = (await app.inject({ url: `${url}&page=3`, headers: adminHeaders })).json();
                assert.equal(beyond.total, 2); assert.deepEqual(beyond.items, []);
                const all = (await app.inject({ url: `/api/admin/tutorials?keyword=${encodeURIComponent(keyword)}`, headers: adminHeaders })).json();
                assert.equal(all.total, 4); assert.deepEqual(all.items.map((item: { id: string }) => item.id), ids);
                const published = (await app.inject({ url: `/api/library/tutorials?format=workflow&keyword=${encodeURIComponent(keyword)}` })).json();
                assert.equal(published.total, 1); assert.equal(published.items[0].id, ids[1]);
                assert.equal((await app.inject({ url: "/api/admin/tutorials?format=unknown", headers: adminHeaders })).statusCode, 400);
            } finally {
                if (ids.length) await app.inject({ method: "POST", url: "/api/admin/tutorials/delete", headers: adminHeaders, payload: { ids } });
            }
        });
        await suite.test("workflow audio uploads and media permissions follow tutorial publication and availability", { skip: !process.env.TEST_S3_ENDPOINT }, async () => {
            const bytes = new Uint8Array([1, 2, 3, 4]), sha256 = digest(Buffer.from(bytes));
            const prepared = await app.inject({ method: "POST", url: "/api/admin/media/uploads", headers: adminHeaders, payload: { bytes: bytes.length, mimeType: "audio/mpeg", sha256 } });
            assert.equal(prepared.statusCode, 200, prepared.body);
            const { id: mediaId, upload } = prepared.json(), body = new FormData();
            for (const [key, value] of Object.entries(upload.fields)) body.append(key, String(value));
            body.append("file", new Blob([bytes], { type: "audio/mpeg" }));
            const uploaded = await fetch(upload.url, { method: "POST", body }); assert.ok(uploaded.ok, await uploaded.text());
            const workflow: WorkflowDocument = { version: 1, nodes: [{ id: "audio", type: "audio", title: "示例音频", width: 200, height: 120, position: { x: 0, y: 0 }, metadata: { content: `/api/library/media/${mediaId}`, storageKey: `workflow:${mediaId}`, status: "success", bytes: bytes.length, mimeType: "audio/mpeg" } }], connections: [], models: {}, media: [{ mediaId, bytes: bytes.length, mimeType: "audio/mpeg", sha256 }] };
            const data = { title: "Audio workflow fixture", format: "workflow", workflow };
            const create = () => app.inject({ method: "POST", url: "/api/admin/tutorials", headers: adminHeaders, payload: { data, published: false } });
            assert.equal((await create()).statusCode, 400);
            assert.equal((await app.inject({ method: "POST", url: `/api/admin/media/${mediaId}/complete`, headers: adminHeaders, payload: {} })).statusCode, 200);
            workflow.media[0].sha256 = "0".repeat(64); assert.equal((await create()).statusCode, 400); workflow.media[0].sha256 = sha256;
            const created = await create(); assert.equal(created.statusCode, 200, created.body);
            const { id } = created.json(), mediaUrl = `/api/library/media/${mediaId}`;
            assert.equal((await app.inject({ url: mediaUrl })).statusCode, 401);
            assert.equal((await app.inject({ url: mediaUrl, headers })).statusCode, 403);
            assert.equal((await app.inject({ url: mediaUrl, headers: adminHeaders })).statusCode, 302);
            assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/tutorials/${id}`, headers: adminHeaders, payload: { data, published: true, revision: 1 } })).statusCode, 200);
            const download = await app.inject({ url: mediaUrl }); assert.equal(download.statusCode, 302);
            assert.deepEqual(new Uint8Array(await (await fetch(download.headers.location!)).arrayBuffer()), bytes);
            const settings = (await app.inject({ url: "/api/admin/settings", headers: adminHeaders })).json();
            settings.data.publicContent.tutorials = false;
            assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: adminHeaders, payload: settings })).statusCode, 200);
            assert.equal((await app.inject({ url: mediaUrl })).statusCode, 401);
            assert.equal((await app.inject({ url: `/api/library/tutorials/${id}` })).statusCode, 404);
            settings.revision++; settings.data.publicContent.tutorials = true;
            assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: adminHeaders, payload: settings })).statusCode, 200);
            assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/tutorials/${id}`, headers: adminHeaders, payload: { data, published: false, revision: 2 } })).statusCode, 200);
            assert.equal((await app.inject({ url: mediaUrl })).statusCode, 401);
            await app.inject({ method: "POST", url: "/api/admin/tutorials/delete", headers: adminHeaders, payload: { ids: [id] } });
            assert.equal((await app.inject({ url: `/api/library/tutorials/${id}` })).statusCode, 404);
            assert.equal((await app.inject({ url: mediaUrl })).statusCode, 401);
        });
        await suite.test("public media signed upload, publication and withdrawal", {skip:!process.env.TEST_S3_ENDPOINT}, async()=>{
            const bytes=new Uint8Array([1,2,3,4]);
            const prepared=await app.inject({method:"POST",url:"/api/admin/media/uploads",headers:adminHeaders,payload:{bytes:bytes.length,mimeType:"image/png",sha256:digest(Buffer.from(bytes))}});
            assert.equal(prepared.statusCode,200,prepared.body);
            const {id:mediaId,upload}=prepared.json();const body=new FormData();
            for(const [key,value] of Object.entries(upload.fields))body.append(key,String(value));
            body.append("file",new Blob([bytes],{type:"image/png"}));
            const uploaded=await fetch(upload.url,{method:"POST",body});assert.ok(uploaded.ok,await uploaded.text());
            const completed=await app.inject({method:"POST",url:`/api/admin/media/${mediaId}/complete`,headers:adminHeaders,payload:{}});
            assert.equal(completed.statusCode,200,completed.body);
            const url=`/api/library/media/${mediaId}`;
            assert.equal((await app.inject({url})).statusCode,401);
            const data={title:"Public image",assetKind:"image",mediaId};
            const created=await app.inject({method:"POST",url:"/api/admin/assets",headers:adminHeaders,payload:{data,published:true}});
            assert.equal(created.statusCode,200,created.body);
            const download=await app.inject({url});assert.equal(download.statusCode,302);
            const file=await fetch(download.headers.location!);assert.ok(file.ok);
            assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);
            const id=created.json().id;
            assert.equal((await app.inject({method:"PATCH",url:`/api/admin/assets/${id}`,headers:adminHeaders,payload:{data,published:false,revision:1}})).statusCode,200);
            assert.equal((await app.inject({url})).statusCode,401);
            assert.equal((await app.inject({url,headers:adminHeaders})).statusCode,302);
            assert.ok((await pool.query("SELECT 1 FROM canvas_admin_audit WHERE action='media.complete' AND target=$1",[mediaId])).rowCount);
        });
        await suite.test("source sync is idempotent and keeps overrides, tombstones and last successful data",async()=>{
            const created=await app.inject({method:"POST",url:"/api/admin/prompt-sources",headers:adminHeaders,payload:{name:"Fixture source",url:"https://example.com/prompts.json",homepage:"",enabled:true}});
            assert.equal(created.statusCode,200,created.body);const {id}=created.json();
            let remote=[{id:"edited",title:"原始标题",prompt:"正文"},{id:"deleted",title:"手动删除",prompt:"正文"},{id:"gone",title:"远端移除",prompt:"正文"}];
            const sync=()=>syncSource(pool,id,undefined,async()=>remote);
            await sync();await sync();
            const rows=(await pool.query("SELECT * FROM canvas_library WHERE source_id=$1 ORDER BY remote_id",[id])).rows;
            assert.equal(rows.length,3);
            const edited=rows.find(row=>row.remote_id==="edited"),deleted=rows.find(row=>row.remote_id==="deleted");
            assert.equal((await app.inject({method:"PATCH",url:`/api/admin/prompts/${edited.id}`,headers:adminHeaders,payload:{revision:Number(edited.revision),published:true,position:0,data:{...edited.remote_data,title:"人工标题"}}})).statusCode,200);
            await app.inject({method:"POST",url:"/api/admin/prompts/delete",headers:adminHeaders,payload:{ids:[deleted.id]}});
            remote=remote.filter(item=>item.id!=="gone").map(item=>({...item,title:"远程新标题"}));
            assert.equal((await sync()).status,"success");
            const visible=await app.inject({url:`/api/library/prompts?sourceId=${id}`});
            assert.equal(visible.json().total,1);assert.equal(visible.json().items[0].data.title,"人工标题");
            const gone=(await pool.query("SELECT remote_present FROM canvas_library WHERE source_id=$1 AND remote_id='gone'",[id])).rows[0];
            assert.equal(gone.remote_present,false);
            const last=(await pool.query("SELECT last_success_at FROM canvas_prompt_sources WHERE id=$1",[id])).rows[0].last_success_at;
            const failed=await syncSource(pool,id,undefined,async()=>{throw new Error("fixture failure");});
            assert.equal(failed.status,"error");
            assert.equal((await app.inject({url:`/api/library/prompts?sourceId=${id}`})).json().total,1);
            assert.deepEqual((await pool.query("SELECT last_success_at FROM canvas_prompt_sources WHERE id=$1",[id])).rows[0].last_success_at,last);
            let release!:()=>void;const pending=syncSource(pool,id,undefined,()=>new Promise(resolve=>{release=()=>resolve(remote);}));
            while(!release)await new Promise(resolve=>setImmediate(resolve));
            assert.equal((await sync()).status,"running");release();await pending;
            await app.inject({method:"DELETE",url:`/api/admin/prompt-sources/${id}`,headers:adminHeaders});
            assert.equal((await app.inject({url:`/api/library/prompts?sourceId=${id}`})).json().total,0);
        });
        await suite.test("lower quota preserves existing records and permits shrinking/deleting but rejects growth",async()=>{
            // Bob is isolated from earlier Alice media reservations.
            const cookie=await login("bob"),ownerHeaders={cookie,origin:config.PUBLIC_URL};
            await pool.query("UPDATE canvas_users SET storage_bytes=2147483648 WHERE id=$1",[bobId]);
            const input={...record,id:"quota-record",data:{id:"quota-record",text:"x".repeat(256)}};
            const initial=await app.inject({method:"POST",url:"/api/sync/records",headers:ownerHeaders,payload:input});
            assert.equal(initial.statusCode,200,initial.body);
            await app.inject({method:"PATCH",url:`/api/admin/users/${bobId}`,headers:adminHeaders,payload:{enabled:true,note:"",storageBytes:1}});
            const same=await app.inject({method:"POST",url:"/api/sync/records",headers:ownerHeaders,payload:{...input,baseRevision:initial.json().revision}});
            assert.equal(same.statusCode,200,same.body);
            const growth=await app.inject({method:"POST",url:"/api/sync/records",headers:ownerHeaders,payload:{...input,baseRevision:same.json().revision,data:{id:"quota-record",text:"x".repeat(512)}}});
            assert.equal(growth.statusCode,413);
            const shrink=await app.inject({method:"POST",url:"/api/sync/records",headers:ownerHeaders,payload:{...input,baseRevision:same.json().revision,data:{id:"quota-record",text:"x"}}});
            assert.equal(shrink.statusCode,200,shrink.body);
            assert.equal((await app.inject({method:"POST",url:"/api/sync/records",headers:ownerHeaders,payload:{...input,baseRevision:shrink.json().revision,deleted:true,data:null}})).statusCode,200);
        });
        await suite.test("browser call IDs are account-bound, terminal updates are idempotent and secrets are rejected",async()=>{
            const accountId=(await app.inject({url:"/api/auth/session",headers})).json().user.id;
            const event={id:"logical-video-call",accountId,operation:"video",model:"fixture-model",status:"running",startedAt:new Date().toISOString(),finishedAt:null,inputText:"prompt",outputText:"",error:"",parameters:{seconds:"4"},media:{inputCount:1,outputCount:0,inputTypes:["image"],outputType:"video"},usage:{inputTokens:null,outputTokens:null,totalTokens:null}};
            const post=(payload:unknown)=>app.inject({method:"POST",url:"/api/ai-events",headers,payload});
            assert.equal((await post({...event,accountId:bobId})).statusCode,403);
            assert.equal((await post({...event,parameters:{apiKey:"secret"}})).statusCode,400);
            assert.equal((await post(event)).statusCode,200);
            const finished={...event,status:"success",finishedAt:new Date().toISOString(),media:{...event.media,outputCount:1}};
            await post(finished);await post(event);await post({...finished,status:"error"});
            const rows=(await pool.query("SELECT data FROM canvas_ai_requests WHERE user_id=$1 AND id=$2",[accountId,event.id])).rows;
            assert.equal(rows.length,1);assert.equal(rows[0].data.status,"success");assert.equal(rows[0].data.usage.totalTokens,null);
            for(const status of ["error","cancelled"]){assert.equal((await post({...finished,id:status,status,error:"Bearer secret data:image/png;base64,AAAA"})).statusCode,200);}
            const logs=(await app.inject({url:"/api/admin/ai-logs?model=fixture-model",headers:adminHeaders})).json().items;
            assert.equal(logs.length,3);assert.ok(logs.every((item:any)=>item.cost===null&&!item.error.includes("Bearer secret")));
        });
        await suite.test("logout invalidates sessions", async () => {
            assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers, payload: {} })).statusCode, 200);
            assert.equal((await app.inject({ url: "/api/auth/session", headers })).json().user, null);
        });
        await suite.test("browser sessions share one encrypted credential and serialize refresh without losing another browser's session", async () => {
            const cookies = [await login("shared-user"), await login("shared-user")];
            const id = (await app.inject({ url: "/api/auth/session", headers: { cookie: cookies[0] } })).json().user.id;
            const credential = decrypt<Credentials>((await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [id])).rows[0].oauth_credentials, config.ENCRYPTION_KEY);
            await pool.query("UPDATE canvas_users SET oauth_credentials=$2 WHERE id=$1", [id, encrypt({ ...credential, expiresAt: 0 }, config.ENCRYPTION_KEY)]);
            const before = refreshRequests;
            const results = await Promise.all(cookies.map(cookie => app.inject({ method: "POST", url: "/api/auth/credentials", headers: { cookie, origin: config.PUBLIC_URL }, payload: {} })));
            for (const result of results) assert.equal(result.statusCode, 200, result.body);
            assert.equal(refreshRequests, before + 1);
            await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookies[0], origin: config.PUBLIC_URL }, payload: {} });
            assert.equal((await app.inject({ url: "/api/auth/session", headers: { cookie: cookies[0] } })).json().user, null);
            assert.equal((await app.inject({ url: "/api/auth/session", headers: { cookie: cookies[1] } })).json().user.id, id);
        });
        await suite.test("provider errors preserve sessions; invalid grants clear their session and cookie", async () => {
            for (const [status, error, expected] of [[429, "temporarily_unavailable", 429], [503, "temporarily_unavailable", 502], [401, "invalid_client", 502], [400, "invalid_grant", 401]] as const) {
                const cookie = await login("failed-refresh-user");
                const id = (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().user.id;
                const credential = decrypt<Credentials>((await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [id])).rows[0].oauth_credentials, config.ENCRYPTION_KEY);
                await pool.query("UPDATE canvas_users SET oauth_credentials=$2 WHERE id=$1", [id, encrypt({ ...credential, expiresAt: 0 }, config.ENCRYPTION_KEY)]);
                tokenStatus = status; tokenError = error;
                try {
                    const result = await app.inject({ method: "POST", url: "/api/auth/credentials", headers: { cookie, origin: config.PUBLIC_URL }, payload: {} });
                    assert.equal(result.statusCode, expected, result.body);
                    assert.equal(result.cookies.some(item => item.name === "canvas-session" && item.maxAge === 0), expected === 401);
                    const session = (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json();
                    assert.equal(session.user === null, expected === 401);
                } finally { tokenStatus = 200; }
            }
        });
        await suite.test("a downstream failure after successful refresh does not roll back the rotated token", async () => {
            const cookie = await login("refresh-then-error");
            const id = (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().user.id;
            const credential = decrypt<Credentials>((await pool.query("SELECT oauth_credentials FROM canvas_users WHERE id=$1", [id])).rows[0].oauth_credentials, config.ENCRYPTION_KEY);
            await pool.query("UPDATE canvas_users SET oauth_credentials=$2 WHERE id=$1", [id, encrypt({ ...credential, expiresAt: 0 }, config.ENCRYPTION_KEY)]);
            const before = refreshRequests;
            accountStatus = 503;
            try { assert.equal((await app.inject({ url: "/api/account/overview", headers: { cookie } })).statusCode, 502); }
            finally { accountStatus = 200; }
            assert.equal((await app.inject({ url: "/api/account/overview", headers: { cookie } })).statusCode, 200);
            assert.equal(refreshRequests, before + 1);
        });
    } finally {
        await app.close(); await pool.end(); await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
});
