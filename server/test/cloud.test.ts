import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { challenge, decrypt, digest, encrypt, localReturnPath } from "../src/crypto.js";
import type { Credentials } from "../src/auth.js";

test("authenticated encryption rejects tampering and return paths stay local", () => {
    const key = randomBytes(32).toString("hex");
    const encrypted = encrypt({ token: "secret" }, key);
    assert.deepEqual(decrypt(encrypted, key), { token: "secret" });
    const buffer = Buffer.from(encrypted, "base64"); buffer[20] ^= 1;
    assert.throws(() => decrypt(buffer.toString("base64"), key));
    for (const path of ["//evil.invalid/", "/\\evil.invalid/", "https://evil.invalid/", "/api/auth/logout"]) assert.equal(localReturnPath(path), "/");
    assert.equal(localReturnPath("/canvas/abc?test=1"), "/canvas/abc?test=1");
});

test("PostgreSQL auth, isolation, revision conflicts, media quota", { skip: !process.env.TEST_DATABASE_URL }, async (suite) => {
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    await migrate(pool);
    await pool.query("TRUNCATE canvas_media,canvas_records,canvas_sessions,canvas_oauth_flows,canvas_users CASCADE");
    const codes = new Map<string, { challenge: string; user: string }>();
    let provider: Server;
    provider = createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/canvas-oauth/token") {
            let body = ""; for await (const chunk of request) body += chunk;
            const params = new URLSearchParams(body);
            const grant = codes.get(params.get("code") || "");
            if (!grant || grant.challenge !== challenge(params.get("code_verifier") || "")) { response.statusCode = 400; return response.end("{}"); }
            codes.delete(params.get("code")!);
            return response.end(JSON.stringify({ access_token: grant.user, refresh_token: `refresh-${grant.user}`, expires_in: 3600 }));
        }
        if (request.url === "/api/canvas-oauth/userinfo") {
            const user = request.headers.authorization?.replace("Bearer ", "");
            return response.end(JSON.stringify({ sub: user, username: user, display_name: user, avatar_url: "" }));
        }
        if (request.url === "/api/canvas-oauth/credentials") return response.end(JSON.stringify({ apiKey: "sk-test", baseUrl: "http://localhost:33002" }));
        response.statusCode = 404; response.end("{}");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as { port: number }).port;
    const config = readConfig({ PUBLIC_URL: "http://localhost:3000", LLMROAM_URL: `http://127.0.0.1:${providerPort}`, OAUTH_CLIENT_ID: "canvas", OAUTH_CLIENT_SECRET: "s".repeat(32), DATABASE_URL: process.env.TEST_DATABASE_URL!, ENCRYPTION_KEY: randomBytes(32).toString("hex"), S3_ENDPOINT: "http://localhost:9000", S3_PUBLIC_ENDPOINT: "http://localhost:9000", S3_REGION: "us-east-1", S3_BUCKET: "canvas", S3_ACCESS_KEY: "test", S3_SECRET_KEY: "test-secret", MAX_MEDIA_BYTES: "8", USER_STORAGE_BYTES: "12" });
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
            assert.equal((await app.inject({ url: flow.url, headers: { cookie: "canvas-flow=wrong" } })).statusCode, 400);
            const result = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
            assert.equal(result.statusCode, 302, result.body);
            assert.equal((await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })).statusCode, 400);
            const rows = await pool.query("SELECT id_hash,credentials FROM canvas_sessions");
            assert.ok(!rows.rows[0].credentials.includes("state-user"));
            assert.equal(decrypt<Credentials>(rows.rows[0].credentials, config.ENCRYPTION_KEY).accessToken, "state-user");
        });
        const first = await login("alice"); const second = await login("bob");
        const headers = { cookie: first, origin: config.PUBLIC_URL };
        const record = { domain: "canvas", id: "shared-id", baseRevision: 0, deleted: false, data: { id: "shared-id", title: "First" }, media: [] };
        await suite.test("authentication and CSRF fail closed", async () => {
            assert.equal((await app.inject({ url: "/api/sync/changes" })).statusCode, 401);
            assert.equal((await app.inject({ method: "POST", url: "/api/sync/records", headers: { cookie: first, origin: "https://evil.invalid" }, payload: record })).statusCode, 403);
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
            const payload = { storageKey: "image:one", bytes: 8, mimeType: "image/png", sha256: "a".repeat(64) };
            const upload = await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload });
            assert.equal(upload.statusCode, 200, upload.body);
            const policy = JSON.parse(Buffer.from(upload.json().upload.fields.Policy, "base64").toString());
            assert.ok(policy.conditions.some((condition: unknown[]) => Array.isArray(condition) && condition[0] === "content-length-range" && condition[1] === 8 && condition[2] === 8));
            assert.equal((await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload: { ...payload, storageKey: "image:two" } })).statusCode, 413);
            assert.equal((await app.inject({ url: `/api/media/${upload.json().id}/url`, headers: { cookie: second } })).statusCode, 404);
            assert.equal((await app.inject({ method: "POST", url: "/api/media/uploads", headers, payload: { ...payload, bytes: 9 } })).statusCode, 400);
        });
        await suite.test("logout invalidates sessions", async () => {
            assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers, payload: {} })).statusCode, 200);
            assert.equal((await app.inject({ url: "/api/auth/session", headers })).json().user, null);
        });
    } finally {
        await app.close(); await pool.end(); await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
});
