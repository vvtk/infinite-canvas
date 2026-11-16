import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Session } from "../auth.js";
import { encrypt } from "../crypto.js";
import { transaction } from "../db.js";
import { audit, fail } from "../management.js";
import { previewRestore, readBackup } from "./backups.js";
import { clientFor, controlLock, initializeStorage, poolReferenced, poolSchema, publicPool, readPool } from "./pools.js";
import { createStorageTask, idleMaintenance, storageTaskRunner } from "./tasks.js";

const paramsId = z.object({ id: z.string().min(1) });
const taskSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("migration"), sourcePoolId: z.string(), targetPoolId: z.string() }).strict(),
    z.object({ kind: z.literal("backup"), sourcePoolId: z.string(), targetPoolId: z.string() }).strict(),
    z.object({ kind: z.literal("cleanup"), migrationTaskId: z.string() }).strict(),
    z.object({ kind: z.literal("delete-backup"), backupId: z.string() }).strict(),
    z.object({ kind: z.literal("restore"), backupId: z.string(), previewId: z.string(), targetPoolId: z.string(), selected: z.array(z.string()) }).strict(),
]);
export async function storageRoutes(app: FastifyInstance, pool: Pool, config: Config, requireSuperAdmin: (request: FastifyRequest) => Promise<Session>) {
    await initializeStorage(pool, config);
    const run = storageTaskRunner(app, pool, config);
    app.get("/api/admin/storage/pools", async request => {
        await requireSuperAdmin(request);
        const items = (await pool.query(`SELECT p.*,
            (SELECT COUNT(*) FROM (SELECT id FROM canvas_media WHERE pool_id=p.id AND (ready OR expires_at>now()) UNION ALL SELECT id FROM canvas_public_media WHERE pool_id=p.id AND (ready OR expires_at>now())) m) AS media_count,
            (SELECT COALESCE(SUM(bytes),0) FROM (SELECT bytes FROM canvas_media WHERE pool_id=p.id AND (ready OR expires_at>now()) UNION ALL SELECT bytes FROM canvas_public_media WHERE pool_id=p.id AND (ready OR expires_at>now())) m) AS used_bytes,
            (SELECT COALESCE(SUM(bytes),0) FROM canvas_storage_backups WHERE target_pool_id=p.id AND status<>'deleted') AS backup_bytes
            FROM canvas_storage_pools p ORDER BY p.created_at,p.id`)).rows.map(publicPool);
        const policy = (await pool.query("SELECT * FROM canvas_storage_policy WHERE id=true")).rows[0];
        return { items, policy: { mode: policy.mode, defaultPoolId: policy.default_pool_id, revision: Number(policy.revision) } };
    });
    app.post("/api/admin/storage/pools", async request => {
        const actor = await requireSuperAdmin(request), input = poolSchema.parse(request.body), id = randomUUID();
        if (!input.accessKey || !input.secretKey) fail(400, "请填写完整的存储凭据");
        await transaction(pool, async db => {
            await controlLock(db);
            await db.query("SELECT id FROM canvas_storage_policy WHERE id=true FOR UPDATE");
            if ((await db.query("SELECT 1 FROM canvas_storage_pools WHERE endpoint=$1 AND bucket=$2 AND prefix=$3", [new URL(input.endpoint).origin, input.bucket, input.prefix.replace(/\/+$/, "")])).rowCount) fail(409, "相同地址、Bucket 和前缀的存储池已存在");
            await db.query("INSERT INTO canvas_storage_pools(id,name,provider,endpoint,public_endpoint,region,bucket,prefix,path_style,writable,credentials,capacity_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [id, input.name, input.provider, new URL(input.endpoint).origin, new URL(input.publicEndpoint).origin, input.region, input.bucket, input.prefix.replace(/\/+$/, ""), input.pathStyle, input.writable, encrypt({ accessKey: input.accessKey, secretKey: input.secretKey }, config.ENCRYPTION_KEY), input.capacityBytes]);
            if (input.writable) await db.query("UPDATE canvas_storage_policy SET default_pool_id=COALESCE(default_pool_id,$1),revision=revision+1 WHERE id=true", [id]);
            await audit(db, actor.userId, "storage.pool.create", id, { name: input.name, provider: input.provider });
        });
        return { id };
    });
    app.patch("/api/admin/storage/pools/:id", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params);
        const input = poolSchema.extend({ revision: z.number().int().positive() }).parse(request.body);
        await transaction(pool, async db => {
            await controlLock(db);
            const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
            const old = await readPool(db, id);
            if (Number(old.revision) !== input.revision) fail(409, "存储池已修改，请刷新");
            const endpoint = new URL(input.endpoint).origin, publicEndpoint = new URL(input.publicEndpoint).origin, prefix = input.prefix.replace(/\/+$/, "");
            const locationChanged = old.provider !== input.provider || old.endpoint !== endpoint || old.public_endpoint !== publicEndpoint || old.bucket !== input.bucket || old.prefix !== prefix || old.region !== input.region || old.path_style !== input.pathStyle;
            if (locationChanged && await poolReferenced(db, id)) fail(409, "存储池已有媒体、备份或任务引用，请新建池并迁移");
            if ((await db.query("SELECT 1 FROM canvas_storage_pools WHERE id<>$1 AND endpoint=$2 AND bucket=$3 AND prefix=$4", [id, endpoint, input.bucket, prefix])).rowCount) fail(409, "相同地址、Bucket 和前缀的存储池已存在");
            if (!input.writable && policy.default_pool_id === id) fail(409, "请先切换默认池，再停止此池写入");
            if (input.writable && (await db.query("SELECT 1 FROM canvas_storage_tasks WHERE kind='migration' AND status<>'completed' AND source_pool_id=$1", [id])).rowCount) fail(409, "源池仍有未完成迁移，请完成迁移后再开启写入");
            if (old.writable !== input.writable && (await db.query("SELECT 1 FROM canvas_storage_tasks WHERE status IN ('pending','running') AND (source_pool_id=$1 OR target_pool_id=$1)", [id])).rowCount) fail(409, "维护任务运行中，暂不能调整池的写入状态");
            if (!!input.accessKey !== !!input.secretKey) fail(400, "轮换凭据时请同时填写 Access Key 和 Secret Key");
            const credentials = input.accessKey ? encrypt({ accessKey: input.accessKey, secretKey: input.secretKey }, config.ENCRYPTION_KEY) : old.credentials;
            await db.query("UPDATE canvas_storage_pools SET name=$2,provider=$3,endpoint=$4,public_endpoint=$5,region=$6,bucket=$7,prefix=$8,path_style=$9,writable=$10,credentials=$11,capacity_bytes=$12,revision=revision+1 WHERE id=$1", [id, input.name, input.provider, endpoint, publicEndpoint, input.region, input.bucket, prefix, input.pathStyle, input.writable, credentials, input.capacityBytes]);
            await audit(db, actor.userId, "storage.pool.update", id, { name: input.name, writable: input.writable, credentialsRotated: !!input.accessKey });
        });
        return { success: true };
    });
    app.delete("/api/admin/storage/pools/:id", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params);
        await transaction(pool, async db => {
            await controlLock(db);
            const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
            await readPool(db, id);
            if (await poolReferenced(db, id)) fail(409, "存储池仍被媒体、备份或任务引用，不能删除");
            if (policy.default_pool_id === id) await db.query("UPDATE canvas_storage_policy SET default_pool_id=NULL,revision=revision+1 WHERE id=true");
            await db.query("DELETE FROM canvas_storage_pools WHERE id=$1", [id]);
            await audit(db, actor.userId, "storage.pool.delete", id);
        });
        return { success: true };
    });
    app.post("/api/admin/storage/pools/:id/test", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params), client = await clientFor(pool, config, id);
        try { await client.test(); } catch { fail(400, "连接测试失败，请检查地址、Region、Bucket、凭据和访问权限"); } finally { client.close(); }
        await audit(pool, actor.userId, "storage.pool.test", id);
        return { success: true, message: "Bucket 连接成功；浏览器直传仍需正确配置 CORS 和写入权限" };
    });
    app.patch("/api/admin/storage/policy", async request => {
        const actor = await requireSuperAdmin(request);
        const input = z.object({ mode: z.enum(["single", "round-robin"]), defaultPoolId: z.string().min(1), revision: z.number().int().positive() }).strict().parse(request.body);
        await transaction(pool, async db => {
            await controlLock(db);
            await db.query("SELECT id FROM canvas_storage_policy WHERE id=true FOR UPDATE");
            if (!(await readPool(db, input.defaultPoolId)).writable) fail(409, "默认池必须允许写入");
            if (!(await db.query("UPDATE canvas_storage_policy SET mode=$1,default_pool_id=$2,revision=revision+1 WHERE id=true AND revision=$3", [input.mode, input.defaultPoolId, input.revision])).rowCount) fail(409, "分配策略已修改，请刷新");
            await audit(db, actor.userId, "storage.policy.update", "storage", { mode: input.mode, defaultPoolId: input.defaultPoolId });
        });
        return { success: true };
    });
    app.get("/api/admin/storage/tasks", async request => {
        await requireSuperAdmin(request);
        const rows = (await pool.query(`SELECT t.*,COUNT(i.id)::int AS total,COUNT(i.id) FILTER(WHERE i.status<>'pending')::int AS completed,
            COALESCE(SUM(i.bytes),0) AS bytes,COALESCE(SUM(i.bytes) FILTER(WHERE i.status<>'pending'),0) AS completed_bytes
            FROM canvas_storage_tasks t LEFT JOIN canvas_storage_task_items i ON i.task_id=t.id GROUP BY t.id ORDER BY t.created_at DESC`)).rows;
        return { items: rows.map(row => ({ id: row.id, kind: row.kind, sourcePoolId: row.source_pool_id, targetPoolId: row.target_pool_id, backupId: row.backup_id, status: row.status, error: row.error, total: row.total, completed: row.completed, bytes: Number(row.bytes), completedBytes: Number(row.completed_bytes), createdAt: row.created_at, updatedAt: row.updated_at })) };
    });
    app.get("/api/admin/storage/tasks/:id", async request => {
        await requireSuperAdmin(request); const { id } = paramsId.parse(request.params);
        return { items: (await pool.query("SELECT id,media_kind AS kind,media_id AS \"mediaId\",bytes,status,retire_after AS \"retireAfter\" FROM canvas_storage_task_items WHERE task_id=$1 ORDER BY id", [id])).rows.map(row => ({ ...row, bytes: Number(row.bytes) })) };
    });
    app.post("/api/admin/storage/tasks", async request => {
        const actor = await requireSuperAdmin(request), input = taskSchema.parse(request.body);
        const task = await createStorageTask(pool, config, actor.userId, input);
        run(task.id); return task;
    });
    app.post("/api/admin/storage/tasks/:id/continue", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params);
        await transaction(pool, async db => {
            await controlLock(db); await idleMaintenance(db);
            if (!(await db.query("UPDATE canvas_storage_tasks SET status='pending',error='',updated_at=now() WHERE id=$1 AND status='failed'", [id])).rowCount) fail(409, "任务不存在或不是待继续状态");
            await audit(db, actor.userId, "storage.task.continue", id);
        });
        run(id); return { success: true };
    });
    app.get("/api/admin/storage/backups", async request => {
        await requireSuperAdmin(request);
        return { items: (await pool.query("SELECT * FROM canvas_storage_backups WHERE status<>'deleted' ORDER BY created_at DESC")).rows.map(row => ({ id: row.id, sourcePoolId: row.source_pool_id, targetPoolId: row.target_pool_id, status: row.status, bytes: Number(row.bytes), mediaCount: row.manifest.media.length, recordCount: row.manifest.records.length + row.manifest.library.length + (row.manifest.logoUrl ? 1 : 0), createdAt: row.created_at })) };
    });
    app.post("/api/admin/storage/backups/:id/preview", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params);
        const { manifest } = await readBackup(pool, config, id);
        const result = await transaction(pool, async db => {
            await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            return previewRestore(db, config, id, manifest);
        });
        await audit(pool, actor.userId, "storage.restore.preview", id);
        return result;
    });
    app.delete("/api/admin/storage/backups/:id", async request => {
        const actor = await requireSuperAdmin(request), { id } = paramsId.parse(request.params);
        const task = await createStorageTask(pool, config, actor.userId, { kind: "delete-backup", backupId: id });
        run(task.id); return task;
    });
}
