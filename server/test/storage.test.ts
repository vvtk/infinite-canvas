import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { digest } from "../src/crypto.js";
import { createPool, migrate, transaction } from "../src/db.js";
import { fail, readSettings } from "../src/management.js";
import { mediaRoutes } from "../src/media.js";
import { assertRestoreRevisions, publicMediaIds, recordKey, snapshotBackup, validateManifest, type Manifest } from "../src/storage/backups.js";
import { chooseWritePool, clientFor, poolSchema, publicPool, type Database } from "../src/storage/pools.js";
import { storageClient, verifyObject, copyObject, type PoolRow, type StorageClient } from "../src/storage/provider.js";
import { storageRoutes } from "../src/storage/routes.js";
import { idleMaintenance } from "../src/storage/tasks.js";

const baseEnv = { PUBLIC_URL: "http://localhost:3000", LLMROAM_URL: "http://localhost:33002", OAUTH_CLIENT_ID: "canvas", OAUTH_CLIENT_SECRET: "s".repeat(32), DATABASE_URL: "postgres://fixture", ENCRYPTION_KEY: "a".repeat(64) };
const poolRow: PoolRow = { id: "pool-a", name: "测试池", provider: "s3", endpoint: "https://s3.example.com", public_endpoint: "https://s3.example.com", region: "us-east-1", bucket: "canvas", prefix: "", path_style: true, writable: true, capacity_bytes: null, credentials: "encrypted-private-value", revision: 1 };
const poolInput = { name: "测试池", provider: "s3" as const, endpoint: poolRow.endpoint, publicEndpoint: poolRow.public_endpoint, region: poolRow.region, bucket: poolRow.bucket, prefix: "", pathStyle: true, writable: true, accessKey: "access-fixture", secretKey: "secret-fixture" };
const media = (id = "a", poolId = "pool-a") => ({ kind: "private" as const, id, userId: "alice", storageKey: `image:${id}`, poolId, objectKey: `alice/${id}`, backupKey: `backup/private/${id}`, bytes: 4, sha256: digest(Buffer.from("test")), mimeType: "image/png" });
const manifest = (): Manifest => ({ version: 1, id: "backup", sourcePoolId: "pool-a", createdAt: "2026-01-01T00:00:00.000Z", media: [media()], records: [{ userId: "alice", domain: "canvas", id: "canvas-a", revision: 1, data: { id: "canvas-a", title: "画布" }, media: ["a"] }], library: [], logoUrl: null });
function fakeClient(content: Buffer): StorageClient {
    return { read: async () => Readable.from([content]), put: async () => {}, remove: async () => {}, test: async () => {}, upload: async () => ({ url: "", fields: {} }), url: async () => "", close: () => {} };
}
const database = (query: (sql: string, values?: unknown[]) => Promise<unknown>) => ({ query } as unknown as Database);

test("storage is optional at boot and pool configuration validates origins and prefixes", () => {
    assert.equal(readConfig(baseEnv).S3_BUCKET, undefined);
    assert.equal(readConfig({ ...baseEnv, S3_ACCESS_KEY: "", S3_SECRET_KEY: "" }).S3_ACCESS_KEY, undefined);
    assert.equal(poolSchema.parse(poolInput).provider, "s3");
    for (const endpoint of ["file:///tmp/bucket", "https://user:secret@example.com", "https://example.com/path", "https://example.com?key=secret"]) assert.throws(() => poolSchema.parse({ ...poolInput, endpoint }));
    for (const prefix of ["/root", "a/../b", "./a", "a\\b"]) assert.throws(() => poolSchema.parse({ ...poolInput, prefix }));
});
test("pool responses never contain encrypted or decrypted credentials", () => {
    const result = publicPool(poolRow), serialized = JSON.stringify(result);
    assert.equal(result.hasCredentials, true);
    assert.ok(!serialized.includes("encrypted-private-value"));
    assert.ok(!Object.hasOwn(result, "credentials"));
});
test("S3 upload policies pin object identity, exact size, type and checksum", async () => {
    const client = storageClient(poolRow, { accessKey: "access-fixture", secretKey: "secret-fixture" });
    try {
        const upload = await client.upload("alice/file", { bytes: 4, sha256: media().sha256, mimeType: "image/png" }, 600);
        const policy = JSON.parse(Buffer.from(upload.fields.Policy || upload.fields.policy, "base64").toString());
        assert.ok(JSON.stringify(policy).includes('"content-length-range",4,4'));
        assert.ok(JSON.stringify(policy).includes("x-amz-checksum-sha256"));
        assert.equal(upload.fields.key, "alice/file");
        assert.ok(!JSON.stringify(upload).includes("secret-fixture"));
    } finally { client.close(); }
});
test("OSS uses SDK V4 form and download signatures without exposing the secret key", async () => {
    const client = storageClient({ ...poolRow, provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", public_endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "oss-cn-hangzhou" }, { accessKey: "access-fixture", secretKey: "secret-fixture" });
    try {
        const upload = await client.upload("alice/file", { bytes: 4, sha256: media().sha256, mimeType: "image/png" }, 600);
        assert.equal(upload.fields["x-oss-signature-version"], "OSS4-HMAC-SHA256");
        assert.equal(upload.fields.key, "alice/file");
        assert.equal(new URL(upload.url).hostname, "canvas.oss-cn-hangzhou.aliyuncs.com");
        const policy = JSON.parse(Buffer.from(upload.fields.policy, "base64").toString());
        assert.ok(JSON.stringify(policy.conditions).includes('"content-length-range",4,4'));
        assert.equal(new URL(await client.url("alice/file", 600)).searchParams.get("x-oss-signature-version"), "OSS4-HMAC-SHA256");
        assert.ok(!JSON.stringify(upload).includes("secret-fixture"));
    } finally { client.close(); }
});
test("verification hashes real bytes, rejecting truncated, oversized and corrupt media", async () => {
    const expected = { bytes: 4, sha256: digest(Buffer.from("test")) };
    await verifyObject(fakeClient(Buffer.from("test")), "key", expected);
    for (const value of ["tes", "tests", "xxxx"]) await assert.rejects(() => verifyObject(fakeClient(Buffer.from(value)), "key", expected), /校验和/);
});
test("cross-provider transfer verifies both source bytes and destination bytes", async () => {
    let saved = Buffer.alloc(0), corrupt = false;
    const target = fakeClient(saved);
    target.put = async (_key, body) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        saved = Buffer.concat(chunks);
    };
    target.read = async () => Readable.from([corrupt ? Buffer.from("xxxx") : saved]);
    const expected = { bytes: 4, sha256: digest(Buffer.from("test")), mimeType: "image/png" };
    await copyObject(fakeClient(Buffer.from("test")), target, "source", "target", expected);
    assert.deepEqual(saved, Buffer.from("test"));
    corrupt = true;
    await assert.rejects(() => copyObject(fakeClient(Buffer.from("test")), target, "source", "target", expected), /校验和/);
    await assert.rejects(() => copyObject(fakeClient(Buffer.from("xxxx")), target, "source", "target", expected), /源媒体校验失败/);
});
test("backup manifests reject missing dependencies, ownership changes and unknown formats", () => {
    assert.equal(validateManifest(manifest()).media.length, 1);
    const missing = manifest(); missing.records[0].media.push("missing"); assert.throws(() => validateManifest(missing), /缺失或越权/);
    const foreign = manifest(); foreign.media[0].userId = "bob"; assert.throws(() => validateManifest(foreign), /缺失或越权/);
    assert.throws(() => validateManifest({ ...manifest(), version: 2 }));
    const repeated = manifest(); repeated.media.push(repeated.media[0]); assert.throws(() => validateManifest(repeated), /清单损坏/);
    const logo = manifest(); logo.logoUrl = "/api/library/media/missing"; assert.throws(() => validateManifest(logo), /Logo/);
    assert.deepEqual([...publicMediaIds({ mediaId: "one", nested: [{ coverUrl: "/api/library/media/two" }] })].sort(), ["one", "two"]);
});
test("pool backup closes cross-pool dependencies without copying OAuth or credentials", async () => {
    const rows = [media("a"), media("b", "pool-b")].map(item => ({ id: item.id, user_id: item.userId, storage_key: item.storageKey, pool_id: item.poolId, object_key: item.objectKey, bytes: item.bytes, sha256: item.sha256, mime_type: item.mimeType }));
    const db = database(async sql => {
        if (sql === "SELECT * FROM canvas_media WHERE ready") return { rows };
        if (sql.includes("canvas_records")) return { rows: [{ user_id: "alice", domain: "canvas", id: "p", revision: 1, data: { id: "p" }, media: ["a", "b"] }] };
        return { rows: [] };
    });
    const result = await snapshotBackup(db, "pool-a", "backup", "backups/id");
    assert.deepEqual(result.media.map(item => item.id).sort(), ["a", "b"]);
    assert.equal(result.media.find(item => item.id === "b")?.poolId, "pool-b");
    assert.ok(!JSON.stringify(result).includes("credentials"));
});

test("workflow media manifests participate in backup dependency validation and cross-pool closure", async () => {
    const workflow = { version: 1, nodes: [], connections: [], models: {}, media: [{ mediaId: "audio", bytes: 4, mimeType: "audio/mpeg", sha256: media().sha256 }, { mediaId: "image", bytes: 4, mimeType: "image/png", sha256: media().sha256 }] };
    const data = { title: "流程", format: "workflow", workflow };
    assert.deepEqual([...publicMediaIds(data)].sort(), ["audio", "image"]);
    const value = manifest();
    value.media = ["audio", "image"].map(id => ({ ...media(id), kind: "public", userId: null, storageKey: null }));
    value.records = [];
    value.library = [{ id: "tutorial", kind: "tutorials", revision: 1, position: 0, data }];
    assert.equal(validateManifest(value).library.length, 1);
    const missing = structuredClone(value); missing.media.pop();
    assert.throws(() => validateManifest(missing), /公共媒体依赖缺失/);
    const rows = value.media.map(item => ({ id: item.id, pool_id: item.id === "audio" ? "pool-a" : "pool-b", object_key: item.objectKey, bytes: item.bytes, mime_type: item.mimeType, sha256: item.sha256 }));
    const db = database(async sql => {
        if (sql === "SELECT * FROM canvas_public_media WHERE ready") return { rows };
        if (sql.includes("canvas_library")) return { rows: [{ id: "tutorial", kind: "tutorials", revision: 1, position: 0, data }] };
        return { rows: [] };
    });
    const result = await snapshotBackup(db, "pool-a", "backup", "backups/id");
    assert.deepEqual(result.media.map(item => item.id).sort(), ["audio", "image"]);
    assert.equal(result.media.find(item => item.id === "image")?.poolId, "pool-b");
});
test("restore preview treats tombstones as conflicts and rejects revision changes", async () => {
    const value = manifest(), key = recordKey(value.records[0]);
    const db = database(async () => ({ rows: [{ revision: 4, deleted: true }] }));
    await assert.rejects(() => assertRestoreRevisions(db, value, [{ key, kind: "record", label: "p", state: "missing", revision: null }], [key]), /预览后已变化/);
    await assertRestoreRevisions(db, value, [{ key, kind: "record", label: "p", state: "conflict", revision: 4 }], [key]);
    await assert.rejects(() => assertRestoreRevisions(db, value, [], ["unknown"]), /选择无效/);
});
test("maintenance refuses both an active cross-instance lock and an unfinished queued task", async () => {
    await assert.rejects(() => idleMaintenance(database(async () => ({ rows: [{ locked: false }] }))), /维护任务/);
    await assert.rejects(() => idleMaintenance(database(async sql => sql.includes("pg_try") ? { rows: [{ locked: true }] } : { rows: [{}], rowCount: 1 })), /维护任务/);
});

test("PostgreSQL storage routes encrypt credentials, pin uploads and serialize allocation", { skip: !process.env.TEST_STORAGE_DATABASE_URL }, async suite => {
    // Dedicated disposable database: never share this fixture with cloud.test.ts.
    const pool = createPool(process.env.TEST_STORAGE_DATABASE_URL!), config = readConfig({ ...baseEnv, DATABASE_URL: process.env.TEST_STORAGE_DATABASE_URL! });
    await migrate(pool);
    await pool.query("TRUNCATE canvas_storage_pools,canvas_storage_policy,canvas_users CASCADE");
    await pool.query("INSERT INTO canvas_storage_policy(id) VALUES(true)");
    await pool.query("INSERT INTO canvas_users(id,profile) VALUES('alice','{}'),('admin','{}')");
    const app = Fastify();
    const guard = async (request: { headers: Record<string, unknown> }) => { if (request.headers["x-admin"] !== "yes") fail(403, "无权访问"); return { userId: "admin", hash: "fixture" }; };
    await storageRoutes(app, pool, config, guard);
    mediaRoutes(app, pool, config, async () => ({ userId: "alice", hash: "fixture" }));
    await app.ready();
    const headers = { "x-admin": "yes" };
    try {
        const create = async (name: string, prefix: string) => {
            const response = await app.inject({ method: "POST", url: "/api/admin/storage/pools", headers, payload: { ...poolInput, name, prefix } });
            assert.equal(response.statusCode, 200, response.body); return response.json().id as string;
        };
        const first = await create("A", "a"), second = await create("B", "b");
        await suite.test("permission and credential responses", async () => {
            assert.equal((await app.inject({ url: "/api/admin/storage/pools" })).statusCode, 403);
            const list = await app.inject({ url: "/api/admin/storage/pools", headers });
            assert.ok(!list.body.includes("secret-fixture")); assert.ok(!list.body.includes("access-fixture"));
            const stored = (await pool.query("SELECT credentials FROM canvas_storage_pools WHERE id=$1", [first])).rows[0].credentials;
            assert.ok(!stored.includes("secret-fixture"));
        });
        await suite.test("round robin is atomic across concurrent transactions", async () => {
            await pool.query("UPDATE canvas_storage_policy SET mode='round-robin',cursor=0 WHERE id=true");
            const selected = await Promise.all(Array.from({ length: 8 }, () => transaction(pool, async db => (await chooseWritePool(db)).id)));
            assert.equal(selected.filter(id => id === first).length, 4); assert.equal(selected.filter(id => id === second).length, 4);
        });
        await suite.test("retrying an upload keeps its original pool after a policy change", async () => {
            const payload = { storageKey: "image:fixed", bytes: 4, mimeType: "image/png", sha256: media().sha256 };
            const initial = await app.inject({ method: "POST", url: "/api/media/uploads", payload });
            assert.equal(initial.statusCode, 200, initial.body);
            const id = initial.json().id, destination = (await pool.query("SELECT pool_id FROM canvas_media WHERE id=$1", [id])).rows[0].pool_id;
            await pool.query("UPDATE canvas_storage_policy SET mode='single',default_pool_id=$1 WHERE id=true", [destination === first ? second : first]);
            const retry = await app.inject({ method: "POST", url: "/api/media/uploads", payload });
            assert.equal(retry.statusCode, 200, retry.body);
            assert.equal((await pool.query("SELECT pool_id FROM canvas_media WHERE id=$1", [id])).rows[0].pool_id, destination);
            assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/storage/pools/${destination}`, headers })).statusCode, 409);
            const revision = Number((await pool.query("SELECT revision FROM canvas_storage_pools WHERE id=$1", [destination])).rows[0].revision);
            assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/storage/pools/${destination}`, headers, payload: { ...poolInput, name: "changed", prefix: "new-location", revision } })).statusCode, 409);
        });
        await suite.test("a failed migration keeps its source closed to new writes", async () => {
            const sourceId = await create("Paused source", "paused"), id = randomUUID();
            await pool.query("UPDATE canvas_storage_pools SET writable=false WHERE id=$1", [sourceId]);
            await pool.query("INSERT INTO canvas_storage_tasks(id,kind,source_pool_id,target_pool_id,actor_id,status) VALUES($1,'migration',$2,$3,'admin','failed')", [id, sourceId, second]);
            const revision = Number((await pool.query("SELECT revision FROM canvas_storage_pools WHERE id=$1", [sourceId])).rows[0].revision);
            const response = await app.inject({ method: "PATCH", url: `/api/admin/storage/pools/${sourceId}`, headers, payload: { ...poolInput, name: "Paused source", prefix: "paused", revision } });
            assert.equal(response.statusCode, 409); assert.match(response.body, /未完成迁移/);
            assert.equal((await pool.query("SELECT writable FROM canvas_storage_pools WHERE id=$1", [sourceId])).rows[0].writable, false);
        });
        await suite.test("real S3 tasks preserve snapshots, resume migrations, defer cleanup and restore with new revisions", { skip: !process.env.TEST_STORAGE_S3_ENDPOINT, timeout: 120_000 }, async context => {
            const endpoint = process.env.TEST_STORAGE_S3_ENDPOINT!, fixture = randomUUID();
            const realInput = { ...poolInput, endpoint, publicEndpoint: endpoint, region: process.env.TEST_STORAGE_S3_REGION || "us-east-1", bucket: process.env.TEST_STORAGE_S3_BUCKET!, accessKey: process.env.TEST_STORAGE_S3_ACCESS_KEY!, secretKey: process.env.TEST_STORAGE_S3_SECRET_KEY! };
            const add = async (name: string, prefix: string) => {
                const result = await app.inject({ method: "POST", url: "/api/admin/storage/pools", headers, payload: { ...realInput, name, prefix } });
                assert.equal(result.statusCode, 200, result.body); return result.json().id as string;
            };
            const sourceId = await add("Live A", `test/${fixture}/a`), targetId = await add("Live B", `test/${fixture}/b`);
            await pool.query("UPDATE canvas_storage_policy SET mode='single',default_pool_id=$1 WHERE id=true", [targetId]);
            const source = await clientFor(pool, config, sourceId), target = await clientFor(pool, config, targetId);
            const bytes = Buffer.from("test"), sha256 = digest(bytes);
            const firstMedia = { ...media(`maintenance-a-${fixture}`), poolId: sourceId, objectKey: `test/${fixture}/a/original` };
            const otherMedia = { ...media(`maintenance-b-${fixture}`, targetId), objectKey: `test/${fixture}/b/original` };
            const publicId = randomUUID(), publicKey = `test/${fixture}/a/public-original`, libraryId = randomUUID(), projectId = `project-${fixture}`;
            const waitTask = async (id: string) => {
                while (!context.signal.aborted) {
                    const row = (await pool.query("SELECT * FROM canvas_storage_tasks WHERE id=$1", [id])).rows[0];
                    if (["failed", "completed"].includes(row.status)) { await transaction(pool, async db => { await db.query("SELECT pg_advisory_xact_lock(731906)"); }); return row; }
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                throw new Error("task fixture timed out");
            };
            const launch = async (payload: unknown) => {
                const result = await app.inject({ method: "POST", url: "/api/admin/storage/tasks", headers, payload });
                assert.equal(result.statusCode, 200, result.body); return waitTask(result.json().id);
            };
            try {
                for (const item of [firstMedia, otherMedia]) {
                    await (item.poolId === sourceId ? source : target).put(item.objectKey, bytes, bytes.length, item.mimeType);
                    await pool.query("INSERT INTO canvas_media(id,user_id,storage_key,pool_id,object_key,bytes,sha256,mime_type,ready,expires_at) VALUES($1,'alice',$2,$3,$4,4,$5,'image/png',true,now())", [item.id, item.storageKey, item.poolId, item.objectKey, sha256]);
                }
                await source.put(publicKey, bytes, 4, "image/png");
                await pool.query("INSERT INTO canvas_public_media(id,pool_id,object_key,bytes,sha256,mime_type,ready,expires_at) VALUES($1,$2,$3,4,$4,'image/png',true,now())", [publicId, sourceId, publicKey, sha256]);
                await pool.query("INSERT INTO canvas_library(id,kind,data,published) VALUES($1,'assets',$2,true)", [libraryId, JSON.stringify({ title: "公开图", assetKind: "image", mediaId: publicId })]);
                const initialRevision = Number((await pool.query("UPDATE canvas_users SET revision=revision+1 WHERE id='alice' RETURNING revision")).rows[0].revision);
                await pool.query("INSERT INTO canvas_records(user_id,domain,id,revision,deleted,data,media) VALUES('alice','canvas',$1,$2,false,$3,$4)", [projectId, initialRevision, JSON.stringify({ id: projectId, title: "原始画布" }), JSON.stringify([firstMedia.id, otherMedia.id])]);
                const settings = await readSettings(pool, config);
                await pool.query("INSERT INTO canvas_site_settings(id,data) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET data=$1,revision=canvas_site_settings.revision+1", [JSON.stringify({ ...settings, logoUrl: `/api/library/media/${publicId}` })]);
                const backupTask = await launch({ kind: "backup", sourcePoolId: sourceId, targetPoolId: targetId });
                assert.equal(backupTask.status, "completed", backupTask.error);
                const backupId = backupTask.backup_id;
                const backup = (await pool.query("SELECT * FROM canvas_storage_backups WHERE id=$1", [backupId])).rows[0];
                assert.equal(backup.manifest.media.length, 3); assert.equal(backup.manifest.records.length, 1);
                assert.equal(backup.manifest.library.length, 1); assert.equal(backup.manifest.logoUrl, `/api/library/media/${publicId}`);
                const blocker = await pool.connect();
                try {
                    await blocker.query("SELECT pg_advisory_lock(731906)");
                    assert.equal((await app.inject({ method: "POST", url: "/api/admin/storage/tasks", headers, payload: { kind: "backup", sourcePoolId: sourceId, targetPoolId: targetId } })).statusCode, 409);
                } finally { await blocker.query("SELECT pg_advisory_unlock(731906)"); blocker.release(); }
                const reservedId = `reservation-${fixture}`;
                await pool.query("INSERT INTO canvas_media(id,user_id,storage_key,pool_id,object_key,bytes,sha256,mime_type,ready,expires_at) VALUES($1,'alice',$2,$3,$4,4,$5,'image/png',false,now()+interval '10 minute')", [reservedId, `image:${reservedId}`, sourceId, `test/${fixture}/a/reserved`, sha256]);
                const migration = await launch({ kind: "migration", sourcePoolId: sourceId, targetPoolId: targetId });
                assert.equal(migration.status, "failed"); assert.match(migration.error, /上传预留/);
                assert.equal((await pool.query("SELECT writable FROM canvas_storage_pools WHERE id=$1", [sourceId])).rows[0].writable, false);
                await pool.query("UPDATE canvas_media SET expires_at=now()-interval '1 second' WHERE id=$1", [reservedId]);
                await pool.query("UPDATE canvas_storage_pools SET writable=false WHERE id=$1", [targetId]);
                await app.inject({ method: "POST", url: `/api/admin/storage/tasks/${migration.id}/continue`, headers, payload: {} });
                const paused = await waitTask(migration.id);
                assert.equal(paused.status, "failed"); assert.match(paused.error, /目标池需要允许写入/);
                assert.equal((await pool.query("SELECT pool_id FROM canvas_media WHERE id=$1", [firstMedia.id])).rows[0].pool_id, sourceId);
                await pool.query("UPDATE canvas_storage_pools SET writable=true WHERE id=$1", [targetId]);
                assert.equal((await app.inject({ method: "POST", url: `/api/admin/storage/tasks/${migration.id}/continue`, headers, payload: {} })).statusCode, 200);
                assert.equal((await waitTask(migration.id)).status, "completed");
                assert.equal((await pool.query("SELECT pool_id FROM canvas_media WHERE id=$1", [firstMedia.id])).rows[0].pool_id, targetId);
                await verifyObject(source, firstMedia.objectKey, firstMedia);
                const cleanup = await launch({ kind: "cleanup", migrationTaskId: migration.id });
                assert.equal(cleanup.status, "failed"); assert.match(cleanup.error, /签名/);
                await pool.query("UPDATE canvas_storage_task_items SET retire_after=now()-interval '1 second' WHERE task_id=ANY($1::text[])", [[migration.id, cleanup.id]]);
                await app.inject({ method: "POST", url: `/api/admin/storage/tasks/${cleanup.id}/continue`, headers, payload: {} });
                assert.equal((await waitTask(cleanup.id)).status, "completed");
                await assert.rejects(() => source.read(firstMedia.objectKey));
                const revision = Number((await pool.query("UPDATE canvas_users SET revision=revision+1 WHERE id='alice' RETURNING revision")).rows[0].revision);
                await pool.query("UPDATE canvas_records SET revision=$2,deleted=true,data=NULL,media='[]' WHERE id=$1", [projectId, revision]);
                const previewResult = await app.inject({ method: "POST", url: `/api/admin/storage/backups/${backupId}/preview`, headers, payload: {} });
                assert.equal(previewResult.statusCode, 200, previewResult.body);
                const preview = previewResult.json();
                assert.equal(preview.entries.find((item: { kind: string }) => item.kind === "record").state, "conflict");
                const selected = preview.entries.map((item: { key: string }) => item.key);
                await pool.query("UPDATE canvas_records SET revision=revision+1 WHERE id=$1", [projectId]);
                assert.equal((await app.inject({ method: "POST", url: "/api/admin/storage/tasks", headers, payload: { kind: "restore", backupId, previewId: preview.id, targetPoolId: targetId, selected } })).statusCode, 409);
                const fresh = (await app.inject({ method: "POST", url: `/api/admin/storage/backups/${backupId}/preview`, headers, payload: {} })).json();
                await pool.query("UPDATE canvas_users SET storage_bytes=1 WHERE id='alice'");
                assert.equal((await app.inject({ method: "POST", url: "/api/admin/storage/tasks", headers, payload: { kind: "restore", backupId, previewId: fresh.id, targetPoolId: targetId, selected } })).statusCode, 413);
                assert.equal((await pool.query("SELECT deleted FROM canvas_records WHERE id=$1", [projectId])).rows[0].deleted, true);
                await pool.query("UPDATE canvas_users SET storage_bytes=NULL WHERE id='alice'");
                const restored = await launch({ kind: "restore", backupId, previewId: fresh.id, targetPoolId: targetId, selected });
                assert.equal(restored.status, "completed", restored.error);
                const project = (await pool.query("SELECT * FROM canvas_records WHERE id=$1", [projectId])).rows[0];
                assert.equal(project.deleted, false); assert.ok(Number(project.revision) > revision);
                assert.equal((await pool.query("SELECT published FROM canvas_library WHERE id=$1", [libraryId])).rows[0].published, false);
                const current = (await pool.query("SELECT object_key FROM canvas_media WHERE id=$1", [firstMedia.id])).rows[0];
                await verifyObject(target, current.object_key, firstMedia);
                const deleted = await app.inject({ method: "DELETE", url: `/api/admin/storage/backups/${backupId}`, headers });
                assert.equal(deleted.statusCode, 200, deleted.body);
                assert.equal((await waitTask(deleted.json().id)).status, "completed");
                await assert.rejects(() => target.read(backup.manifest_key));
                await verifyObject(target, current.object_key, firstMedia);
                const interrupted = randomUUID();
                await pool.query("INSERT INTO canvas_storage_tasks(id,kind,source_pool_id,target_pool_id,actor_id,status) VALUES($1,'migration',$2,$3,'admin','running')", [interrupted, sourceId, targetId]);
                const restarted = Fastify();
                try { await storageRoutes(restarted, pool, config, guard); await restarted.ready(); assert.equal((await pool.query("SELECT status FROM canvas_storage_tasks WHERE id=$1", [interrupted])).rows[0].status, "failed"); }
                finally { await restarted.close(); }
            } finally { source.close(); target.close(); }
        });
    } finally { await app.close(); await pool.end(); }
});
