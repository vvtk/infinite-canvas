import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import type { RestoreEntry, StorageTaskKind } from "../../../shared/storage.js";
import type { Config } from "../config.js";
import { digest } from "../crypto.js";
import { transaction } from "../db.js";
import { audit, fail, readSettings, storageQuota, storageUsage } from "../management.js";
import { clientFor, controlLock, mediaTable, objectKey, readPool, type Database } from "./pools.js";
import { copyObject, verifyObject } from "./provider.js";
import { assertRestoreQuota, assertRestoreRevisions, libraryKey, readBackup, recordKey, snapshotBackup, validateManifest, type Manifest, type MediaSnapshot } from "./backups.js";

type TaskInput = { kind: "migration" | "backup"; sourcePoolId: string; targetPoolId: string } | { kind: "cleanup"; migrationTaskId: string } | { kind: "delete-backup"; backupId: string } | { kind: "restore"; backupId: string; previewId: string; targetPoolId: string; selected: string[] };
type TaskRow = { id: string; kind: StorageTaskKind; source_pool_id: string; target_pool_id: string; backup_id: string | null; actor_id: string; status: string; data: { migrationTaskId?: string; manifest?: Manifest; expected?: RestoreEntry[]; selected?: string[] }; };
type ItemRow = { id: string; media_kind: string; media_id: string; source_pool_id: string; target_pool_id: string; source_key: string; target_key: string; bytes: string; sha256: string; mime_type: string; status: string; retire_after: Date | null };

async function taskTransaction<T>(client: PoolClient, work: (db: PoolClient) => Promise<T>) {
    // All mutations use the connection owning the session advisory lock. A lost lock connection
    // cannot keep committing work through other pool connections after another instance takes over.
    await client.query("BEGIN");
    try { const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
}

export async function idleMaintenance(db: Database) {
    if (!(await db.query("SELECT pg_try_advisory_xact_lock(731906) AS locked")).rows[0].locked || (await db.query("SELECT 1 FROM canvas_storage_tasks WHERE status IN ('pending','running')")).rowCount) fail(409, "已有存储维护任务，请先处理或继续该任务");
}
async function addItem(db: Database, taskId: string, item: MediaSnapshot, targetPoolId: string, targetKey: string, sourcePoolId = item.poolId, sourceKey = item.objectKey) {
    await db.query(`INSERT INTO canvas_storage_task_items(task_id,media_kind,media_id,source_pool_id,target_pool_id,source_key,target_key,bytes,sha256,mime_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(task_id,media_kind,media_id) DO NOTHING`, [taskId, item.kind, item.id, sourcePoolId, targetPoolId, sourceKey, targetKey, item.bytes, item.sha256, item.mimeType]);
}
export async function createStorageTask(pool: Pool, config: Config, actor: string, input: TaskInput) {
    // Verify the remote manifest before opening the snapshot transaction.
    const restored = input.kind === "restore" ? await readBackup(pool, config, input.backupId) : null;
    return transaction(pool, async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await controlLock(db); await idleMaintenance(db);
        const id = randomUUID();
        let sourceId: string | null = null, targetId: string | null = null, backupId: string | null = null;
        let data: TaskRow["data"] = {};
        if (input.kind === "migration" || input.kind === "backup") {
            sourceId = input.sourcePoolId; targetId = input.targetPoolId;
            if (sourceId === targetId) fail(400, "源池和目标池不能相同");
            await readPool(db, sourceId);
            const target = await readPool(db, targetId);
            if (input.kind === "migration") {
                const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
                if (policy.default_pool_id === sourceId) fail(409, "请先将默认写入池切换到其他池，再迁移");
                if (!target.writable) fail(409, "迁移目标池需要允许写入");
                if (!(await db.query("SELECT 1 FROM canvas_storage_pools WHERE writable AND id<>$1", [sourceId])).rowCount) fail(409, "请保留至少一个可写池");
                await db.query("UPDATE canvas_storage_pools SET writable=false,revision=revision+1 WHERE id=$1", [sourceId]);
            } else {
                backupId = randomUUID();
                const prefix = objectKey(target, `.backups/${backupId}`);
                const manifest = await snapshotBackup(db, sourceId, backupId, prefix);
                await db.query("INSERT INTO canvas_storage_backups(id,source_pool_id,target_pool_id,manifest,manifest_key) VALUES($1,$2,$3,$4,$5)", [backupId, sourceId, targetId, JSON.stringify(manifest), `${prefix}/manifest.json`]);
            }
        } else if (input.kind === "cleanup") {
            const migration = (await db.query("SELECT * FROM canvas_storage_tasks WHERE id=$1 AND kind='migration' AND status='completed'", [input.migrationTaskId])).rows[0];
            if (!migration) fail(409, "只能清理已完成的迁移任务");
            if (!(await db.query("SELECT 1 FROM canvas_storage_task_items WHERE task_id=$1 AND status='completed'", [migration.id])).rowCount) fail(409, "没有待清理的源副本");
            sourceId = migration.source_pool_id; targetId = migration.target_pool_id; data = { migrationTaskId: migration.id };
        } else if (input.kind === "delete-backup") {
            const backup = (await db.query("SELECT * FROM canvas_storage_backups WHERE id=$1 AND status='ready' FOR UPDATE", [input.backupId])).rows[0];
            if (!backup) fail(409, "只能删除已完成的备份");
            if ((await db.query("SELECT 1 FROM canvas_storage_tasks WHERE backup_id=$1 AND status<>'completed'", [backup.id])).rowCount) fail(409, "备份仍被未完成任务引用");
            sourceId = backup.target_pool_id; targetId = backup.target_pool_id; backupId = backup.id;
            await db.query("UPDATE canvas_storage_backups SET status='deleting' WHERE id=$1", [backupId]);
        } else {
            const preview = (await db.query("SELECT * FROM canvas_storage_restore_previews WHERE id=$1 AND backup_id=$2 FOR UPDATE", [input.previewId, input.backupId])).rows[0];
            const backup = (await db.query("SELECT * FROM canvas_storage_backups WHERE id=$1 AND status='ready'", [input.backupId])).rows[0];
            if (!preview || !backup || preview.manifest_sha256 !== backup.manifest_sha256 || backup.manifest_sha256 !== restored!.backup.manifest_sha256) fail(409, "备份或预览已变化，请重新预览");
            if (new Set(input.selected).size !== input.selected.length) fail(400, "恢复选项重复");
            await assertRestoreRevisions(db, restored!.manifest, preview.data.entries, input.selected);
            for (const item of restored!.manifest.media) await assertMediaIdentity(db, item);
            await assertRestoreQuota(db, config, restored!.manifest, input.selected);
            const target = await readPool(db, input.targetPoolId);
            if (!target.writable) fail(409, "恢复目标池需要允许写入");
            sourceId = backup.target_pool_id; targetId = input.targetPoolId; backupId = backup.id;
            data = { manifest: restored!.manifest, expected: preview.data.entries, selected: input.selected };
        }
        await db.query("INSERT INTO canvas_storage_tasks(id,kind,source_pool_id,target_pool_id,backup_id,actor_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, input.kind, sourceId, targetId, backupId, actor, JSON.stringify(data)]);
        if (input.kind === "backup") {
            const manifest = (await db.query("SELECT manifest FROM canvas_storage_backups WHERE id=$1", [backupId])).rows[0].manifest as Manifest;
            for (const item of manifest.media) await addItem(db, id, item, targetId!, item.backupKey);
        }
        if (input.kind === "restore") {
            const target = await readPool(db, targetId!);
            for (const item of restored!.manifest.media) await addItem(db, id, item, targetId!, objectKey(target, `.restores/${id}/${item.kind}/${item.id}`), sourceId!, item.backupKey);
        }
        if (input.kind === "cleanup") {
            await db.query(`INSERT INTO canvas_storage_task_items(task_id,media_kind,media_id,source_pool_id,target_pool_id,source_key,target_key,bytes,sha256,mime_type,retire_after)
                SELECT $1,media_kind,media_id,source_pool_id,target_pool_id,source_key,target_key,bytes,sha256,mime_type,retire_after FROM canvas_storage_task_items WHERE task_id=$2 AND status='completed'`, [id, input.migrationTaskId]);
        }
        if (input.kind === "delete-backup") {
            const backup = (await db.query("SELECT * FROM canvas_storage_backups WHERE id=$1", [backupId])).rows[0];
            for (const item of validateManifest(backup.manifest).media) await addItem(db, id, item, sourceId!, item.backupKey, sourceId!, item.backupKey);
            await db.query("INSERT INTO canvas_storage_task_items(task_id,media_kind,media_id,source_pool_id,target_pool_id,source_key,target_key,bytes,sha256,mime_type) VALUES($1,'manifest',$2,$3,$3,$4,$4,$5,$6,'application/json')", [id, backupId, sourceId, backup.manifest_key, backup.manifest_bytes, backup.manifest_sha256]);
        }
        await audit(db, actor, `storage.${input.kind}.create`, id, { sourcePoolId: sourceId, targetPoolId: targetId, backupId });
        return { id };
    }).catch(error => {
        if ((error as { code?: string }).code === "40001") fail(409, "存储状态在创建任务时发生变化，请刷新后重试");
        throw error;
    });
}
async function prepareMigration(client: PoolClient, task: TaskRow) {
    await taskTransaction(client, async db => {
        await controlLock(db);
        const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
        if (policy.default_pool_id === task.source_pool_id || (await readPool(db, task.source_pool_id)).writable) fail(409, "迁移源池必须停止写入且不能作为默认池");
        const target = await readPool(db, task.target_pool_id);
        if (!target.writable) fail(409, "迁移目标池需要允许写入，请调整后手动继续");
        for (const kind of ["private", "public"] as const) {
            const table = mediaTable(kind);
            const rows = (await db.query(`SELECT * FROM ${table} WHERE pool_id=$1 FOR UPDATE`, [task.source_pool_id])).rows;
            if (rows.some(row => !row.ready && new Date(row.expires_at).getTime() > Date.now())) fail(409, "源池仍有有效上传预留，请等待完成或过期后手动继续");
            await db.query(`DELETE FROM ${table} WHERE pool_id=$1 AND NOT ready AND expires_at<=now()`, [task.source_pool_id]);
            for (const row of rows.filter(row => row.ready)) await addItem(db, task.id, { kind, id: row.id, userId: row.user_id || null, storageKey: row.storage_key || null, poolId: row.pool_id, objectKey: row.object_key, backupKey: "", bytes: Number(row.bytes), sha256: row.sha256, mimeType: row.mime_type }, target.id, objectKey(target, `.migrations/${task.id}/${kind}/${row.id}`));
        }
    });
}
async function assertMediaIdentity(db: Database, item: MediaSnapshot) {
    const table = mediaTable(item.kind);
    const current = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [item.id])).rows[0];
    if (current && (current.sha256 !== item.sha256 || Number(current.bytes) !== item.bytes || (item.kind === "private" && (current.user_id !== item.userId || current.storage_key !== item.storageKey)))) fail(409, "现有媒体身份与备份冲突，拒绝覆盖");
    if (item.kind === "private" && (await db.query("SELECT id FROM canvas_media WHERE user_id=$1 AND storage_key=$2 AND id<>$3", [item.userId, item.storageKey, item.id])).rowCount) fail(409, "媒体本地标识与现有记录冲突");
}
async function applyRestore(client: PoolClient, config: Config, task: TaskRow) {
    const manifest = validateManifest(task.data.manifest), selected = task.data.selected || [];
    await taskTransaction(client, async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        // Lock the same owners as sync before checking revisions and quotas.
        await db.query("SELECT id FROM canvas_site_settings WHERE id=true FOR UPDATE");
        const users = [...new Set(manifest.media.filter(item => item.kind === "private").map(item => item.userId!))].sort();
        for (const userId of users) if (!(await db.query("SELECT id FROM canvas_users WHERE id=$1 FOR UPDATE", [userId])).rowCount) fail(409, "备份关联账号不存在");
        if (manifest.library.length) await db.query("SELECT id FROM canvas_library WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [manifest.library.map(item => item.id)]);
        await assertRestoreRevisions(db, manifest, task.data.expected || [], selected);
        await assertRestoreQuota(db, config, manifest, selected);
        const before = new Map<string, number>();
        for (const userId of users) before.set(userId, await storageUsage(db, userId));
        for (const item of manifest.media) {
            await assertMediaIdentity(db, item);
            const copy = (await db.query("SELECT * FROM canvas_storage_task_items WHERE task_id=$1 AND media_kind=$2 AND media_id=$3 AND status='completed'", [task.id, item.kind, item.id])).rows[0];
            if (!copy) fail(409, "恢复媒体尚未全部校验");
            if (item.kind === "private") await db.query(`INSERT INTO canvas_media(id,user_id,storage_key,object_key,bytes,mime_type,sha256,ready,expires_at,pool_id) VALUES($1,$2,$3,$4,$5,$6,$7,true,now(),$8)
                ON CONFLICT(id) DO UPDATE SET object_key=$4,pool_id=$8,ready=true`, [item.id, item.userId, item.storageKey, copy.target_key, item.bytes, item.mimeType, item.sha256, task.target_pool_id]);
            else await db.query(`INSERT INTO canvas_public_media(id,object_key,bytes,mime_type,sha256,ready,expires_at,pool_id) VALUES($1,$2,$3,$4,$5,true,now(),$6)
                ON CONFLICT(id) DO UPDATE SET object_key=$2,pool_id=$6,ready=true`, [item.id, copy.target_key, item.bytes, item.mimeType, item.sha256, task.target_pool_id]);
        }
        for (const record of manifest.records.filter(item => selected.includes(recordKey(item)))) {
            const revision = Number((await db.query("UPDATE canvas_users SET revision=revision+1 WHERE id=$1 RETURNING revision", [record.userId])).rows[0].revision);
            await db.query(`INSERT INTO canvas_records(user_id,domain,id,revision,deleted,data,media) VALUES($1,$2,$3,$4,false,$5,$6)
                ON CONFLICT(user_id,domain,id) DO UPDATE SET revision=$4,deleted=false,data=$5,media=$6`, [record.userId, record.domain, record.id, revision, JSON.stringify(record.data), JSON.stringify(record.media)]);
        }
        for (const record of manifest.library.filter(item => selected.includes(libraryKey(item.id)))) {
            const current = (await db.query("SELECT kind FROM canvas_library WHERE id=$1", [record.id])).rows[0];
            if (current && current.kind !== record.kind) fail(409, "公共内容类型已变化，请重新预览");
            await db.query(`INSERT INTO canvas_library(id,kind,data,published,position) VALUES($1,$2,$3,false,$4)
                ON CONFLICT(id) DO UPDATE SET data=$3,remote_data='{}',source_id=NULL,remote_id=NULL,published=false,deleted=false,remote_present=true,position=$4,revision=canvas_library.revision+1,updated_at=now()`, [record.id, record.kind, JSON.stringify(record.data), record.position]);
        }
        if (selected.includes("logo")) {
            const settings = await readSettings(db, config);
            await db.query("UPDATE canvas_site_settings SET data=$1,revision=revision+1 WHERE id=true", [JSON.stringify({ ...settings, logoUrl: manifest.logoUrl })]);
        }
        for (const userId of users) {
            const used = await storageUsage(db, userId);
            if (used > await storageQuota(db, config, userId) && used > before.get(userId)!) fail(413, "恢复后云存储额度不足，未修改在线数据");
        }
        await db.query("UPDATE canvas_storage_tasks SET status='completed',error='',updated_at=now() WHERE id=$1", [task.id]);
        await audit(db, task.actor_id, "storage.restore.complete", task.id, { selectedCount: selected.length, mediaCount: manifest.media.length });
    });
}
async function cleanupItem(client: PoolClient, config: Config, task: TaskRow, item: ItemRow) {
    await taskTransaction(client, async db => {
        // Keep a row lock across delete so a concurrent restore/sign cannot make this key live again.
        if (item.media_kind !== "manifest") {
            const table = mediaTable(item.media_kind);
            await db.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [item.media_id]);
            if ((await db.query("SELECT 1 FROM canvas_media WHERE pool_id=$1 AND object_key=$2 UNION ALL SELECT 1 FROM canvas_public_media WHERE pool_id=$1 AND object_key=$2", [item.source_pool_id, item.source_key])).rowCount) fail(409, "源副本仍被在线媒体引用，不能清理");
        }
        if (task.kind === "cleanup") {
            if (!item.retire_after || new Date(item.retire_after).getTime() > Date.now()) fail(409, "源副本的已有签名尚未全部失效，请稍后手动继续");
            if ((await db.query(`SELECT 1 FROM canvas_storage_task_items i JOIN canvas_storage_tasks t ON t.id=i.task_id
                WHERE i.source_pool_id=$1 AND i.source_key=$2 AND i.task_id<>$3 AND t.kind IN ('migration','backup','restore') AND t.status<>'completed'`, [item.source_pool_id, item.source_key, task.data.migrationTaskId])).rowCount) fail(409, "源副本仍被其他未完成任务引用");
        }
        const client = await clientFor(db, config, item.source_pool_id);
        try { await client.remove(item.source_key); } finally { client.close(); }
        await db.query("UPDATE canvas_storage_task_items SET status='cleaned' WHERE id=$1", [item.id]);
        if (task.kind === "cleanup") await db.query("UPDATE canvas_storage_task_items SET status='cleaned' WHERE task_id=$1 AND media_kind=$2 AND media_id=$3", [task.data.migrationTaskId, item.media_kind, item.media_id]);
    });
}
export function storageTaskRunner(app: FastifyInstance, pool: Pool, config: Config) {
    let closing = false;
    const running = new Set<Promise<void>>();
    async function execute(id: string) {
        const lock = await pool.connect();
        let acquired = false, disconnected = false;
        const onDisconnect = () => { disconnected = true; };
        lock.on("error", onDisconnect);
        try {
            acquired = (await lock.query("SELECT pg_try_advisory_lock(731906) AS locked")).rows[0].locked;
            if (!acquired) return;
            const task = (await lock.query("UPDATE canvas_storage_tasks SET status='running',error='',updated_at=now() WHERE id=$1 AND status='pending' RETURNING *", [id])).rows[0] as TaskRow | undefined;
            if (!task) return;
            if (task.kind === "migration") await prepareMigration(lock, task);
            if (task.kind === "restore") {
                if (!(await readPool(lock, task.target_pool_id)).writable) fail(409, "恢复目标池需要允许写入，请调整后手动继续");
                const { manifest } = await readBackup(lock, config, task.backup_id!);
                if (!isDeepStrictEqual(manifest, task.data.manifest)) fail(409, "备份已变化，请重新创建恢复任务");
                await taskTransaction(lock, async db => {
                    await assertRestoreRevisions(db, manifest, task.data.expected || [], task.data.selected || []);
                    for (const item of manifest.media) await assertMediaIdentity(db, item);
                    await assertRestoreQuota(db, config, manifest, task.data.selected || []);
                });
            }
            const items = (await lock.query("SELECT * FROM canvas_storage_task_items WHERE task_id=$1 AND status='pending' ORDER BY id", [id])).rows as ItemRow[];
            for (const item of items) {
                if (closing) fail(409, "服务已停止，进度已保留，请手动继续");
                if (task.kind === "cleanup" || task.kind === "delete-backup") { await cleanupItem(lock, config, task, item); continue; }
                const source = await clientFor(lock, config, item.source_pool_id);
                try {
                    const target = await clientFor(lock, config, item.target_pool_id);
                    try { await copyObject(source, target, item.source_key, item.target_key, { bytes: Number(item.bytes), sha256: item.sha256, mimeType: item.mime_type }); }
                    finally { target.close(); }
                } finally { source.close(); }
                await taskTransaction(lock, async db => {
                    if (task.kind === "migration") {
                        const table = mediaTable(item.media_kind);
                        const current = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [item.media_id])).rows[0];
                        if (!current || current.pool_id !== item.source_pool_id || current.object_key !== item.source_key || current.sha256 !== item.sha256) fail(409, "迁移期间媒体归属已变化，拒绝覆盖");
                        await db.query(`UPDATE ${table} SET pool_id=$2,object_key=$3 WHERE id=$1`, [item.media_id, item.target_pool_id, item.target_key]);
                    }
                    await db.query("UPDATE canvas_storage_task_items SET status='completed',retire_after=now()+($2*interval '1 second') WHERE id=$1", [item.id, config.MEDIA_URL_SECONDS]);
                    if (task.kind === "backup") await db.query("UPDATE canvas_storage_backups SET bytes=(SELECT COALESCE(SUM(bytes),0) FROM canvas_storage_task_items WHERE task_id=$2 AND status='completed') WHERE id=$1", [task.backup_id, id]);
                    await db.query("UPDATE canvas_storage_tasks SET updated_at=now() WHERE id=$1", [id]);
                });
            }
            if (closing) fail(409, "服务已停止，进度已保留，请手动继续");
            if (task.kind === "restore") {
                // Recheck completed copies after a restart before making any media visible.
                const verified = (await lock.query("SELECT * FROM canvas_storage_task_items WHERE task_id=$1", [id])).rows as ItemRow[];
                for (const item of verified) {
                    const target = await clientFor(lock, config, item.target_pool_id);
                    try { await verifyObject(target, item.target_key, { bytes: Number(item.bytes), sha256: item.sha256 }); }
                    catch (error) { await lock.query("UPDATE canvas_storage_task_items SET status='pending' WHERE id=$1", [item.id]); throw error; }
                    finally { target.close(); }
                }
                await applyRestore(lock, config, task); return;
            }
            if (task.kind === "backup") {
                const backup = (await lock.query("SELECT * FROM canvas_storage_backups WHERE id=$1", [task.backup_id])).rows[0];
                const manifest = validateManifest(backup.manifest), body = Buffer.from(JSON.stringify(manifest));
                const target = await clientFor(lock, config, task.target_pool_id);
                try {
                    // A resumed backup must not trust old progress if the destination was modified externally.
                    for (const item of manifest.media) {
                        try { await verifyObject(target, item.backupKey, item); }
                        catch (error) { await lock.query("UPDATE canvas_storage_task_items SET status='pending' WHERE task_id=$1 AND media_kind=$2 AND media_id=$3", [id, item.kind, item.id]); throw error; }
                    }
                    await target.put(backup.manifest_key, body, body.length, "application/json");
                    await verifyObject(target, backup.manifest_key, { bytes: body.length, sha256: digest(body) });
                } finally { target.close(); }
                await taskTransaction(lock, async db => {
                    await db.query("UPDATE canvas_storage_backups SET status='ready',manifest_sha256=$2,manifest_bytes=$3,bytes=$4 WHERE id=$1", [backup.id, digest(body), body.length, manifest.media.reduce((sum, item) => sum + item.bytes, body.length)]);
                    await db.query("UPDATE canvas_storage_tasks SET status='completed',error='',updated_at=now() WHERE id=$1", [id]);
                    await audit(db, task.actor_id, "storage.backup.complete", id, { backupId: backup.id });
                }); return;
            }
            await taskTransaction(lock, async db => {
                if (task.kind === "delete-backup") {
                    await db.query("DELETE FROM canvas_storage_restore_previews WHERE backup_id=$1", [task.backup_id]);
                    await db.query("UPDATE canvas_storage_backups SET status='deleted',bytes=0 WHERE id=$1", [task.backup_id]);
                }
                await db.query("UPDATE canvas_storage_tasks SET status='completed',error='',updated_at=now() WHERE id=$1", [id]);
                await audit(db, task.actor_id, `storage.${task.kind}.complete`, id);
            });
        } catch (error) {
            const known = error instanceof Error && error.name === "Error" && [400, 409, 413].includes((error as { statusCode?: number }).statusCode || 0);
            const message = (error as { code?: string }).code === "40001" ? "恢复期间记录发生并发变化，请重新预览后创建恢复任务" : known ? (error as Error).message : "存储操作失败，请检查池的凭据、网络、Bucket 权限后手动继续";
            await lock.query("UPDATE canvas_storage_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'completed'", [id, message]);
        } finally {
            try { if (acquired) await lock.query("SELECT pg_advisory_unlock(731906)"); }
            finally { lock.removeListener("error", onDisconnect); lock.release(disconnected); }
        }
    }
    app.addHook("onReady", async () => {
        await transaction(pool, async db => {
            await controlLock(db);
            if ((await db.query("SELECT pg_try_advisory_xact_lock(731906) AS locked")).rows[0].locked) await db.query("UPDATE canvas_storage_tasks SET status='failed',error='服务中断，进度已保留，请手动继续',updated_at=now() WHERE status IN ('pending','running')");
        });
    });
    app.addHook("onClose", async () => { closing = true; await Promise.allSettled(running); });
    return (id: string) => {
        if (closing) return;
        const promise = execute(id).catch(async () => {
            await transaction(pool, async db => {
                await controlLock(db);
                if ((await db.query("SELECT pg_try_advisory_xact_lock(731906) AS locked")).rows[0].locked) await db.query("UPDATE canvas_storage_tasks SET status='failed',error='任务执行连接中断，进度已保留，请手动继续',updated_at=now() WHERE id=$1 AND status IN ('pending','running')", [id]);
            }).catch(() => undefined);
        }).finally(() => running.delete(promise));
        running.add(promise);
    };
}
