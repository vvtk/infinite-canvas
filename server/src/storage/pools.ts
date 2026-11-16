import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import { transaction } from "../db.js";
import { fail, httpUrl } from "../management.js";
import { storageClient, type PoolRow } from "./provider.js";

export type Database = Pick<Pool | PoolClient, "query">;
const origin = httpUrl.refine(value => { const url = new URL(value); return url.pathname === "/" && !url.search && !url.hash; }, "请填写不带路径的服务地址");
export const poolSchema = z.object({
    name: z.string().trim().min(1), provider: z.enum(["s3", "oss"]), endpoint: origin, publicEndpoint: origin,
    region: z.string().trim().min(1), bucket: z.string().trim().min(1),
    prefix: z.string().trim().default("").refine(value => !value.startsWith("/") && !value.split("/").some(part => part === "." || part === "..") && !/[\\\x00-\x1f]/.test(value)),
    pathStyle: z.boolean(), writable: z.boolean(), capacityBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null), accessKey: z.string().default(""), secretKey: z.string().default(""),
}).strict();
export const mediaTable = (kind: string) => kind === "private" ? "canvas_media" : kind === "public" ? "canvas_public_media" : fail(400, "媒体类型无效");
export const objectKey = (row: Pick<PoolRow, "prefix">, key: string) => [row.prefix.replace(/\/+$/, ""), key].filter(Boolean).join("/");
export async function controlLock(db: Database) {
    await db.query("SELECT pg_advisory_xact_lock(731905)");
    // Fence repeatable-read task snapshots against a concurrent create/continue transaction.
    await db.query("UPDATE canvas_storage_policy SET cursor=cursor WHERE id=true");
}
export async function initializeStorage(pool: Pool, config: Config) {
    await transaction(pool, async db => {
        const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
        if (policy.initialized) return;
        const complete = config.S3_ENDPOINT && config.S3_PUBLIC_ENDPOINT && config.S3_REGION && config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY;
        if (complete) {
            const id = randomUUID();
            await db.query("INSERT INTO canvas_storage_pools(id,name,provider,endpoint,public_endpoint,region,bucket,credentials) VALUES($1,'默认 S3 存储','s3',$2,$3,$4,$5,$6)", [id, config.S3_ENDPOINT, config.S3_PUBLIC_ENDPOINT, config.S3_REGION, config.S3_BUCKET, encrypt({ accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY }, config.ENCRYPTION_KEY)]);
            await db.query("UPDATE canvas_media SET pool_id=$1 WHERE pool_id IS NULL", [id]);
            await db.query("UPDATE canvas_public_media SET pool_id=$1 WHERE pool_id IS NULL", [id]);
            await db.query("UPDATE canvas_storage_policy SET default_pool_id=$1 WHERE id=true", [id]);
        }
        await db.query("UPDATE canvas_storage_policy SET initialized=true WHERE id=true");
    });
}
export async function readPool(db: Database, id: string): Promise<PoolRow> {
    const row = (await db.query("SELECT * FROM canvas_storage_pools WHERE id=$1", [id])).rows[0];
    if (!row) fail(404, "存储池不存在");
    return row;
}
export async function clientFor(db: Database, config: Config, id: string) {
    const row = await readPool(db, id);
    return storageClient(row, decrypt<{ accessKey: string; secretKey: string }>(row.credentials, config.ENCRYPTION_KEY));
}
export async function chooseWritePool(db: Database): Promise<PoolRow> {
    const policy = (await db.query("SELECT * FROM canvas_storage_policy WHERE id=true FOR UPDATE")).rows[0];
    const rows: PoolRow[] = (await db.query("SELECT * FROM canvas_storage_pools WHERE writable ORDER BY created_at,id FOR SHARE")).rows;
    if (!rows.length) fail(409, "未配置可写存储池，请联系管理员");
    if (policy.mode === "single") {
        const selected = rows.find(row => row.id === policy.default_pool_id);
        if (!selected) fail(409, "默认写入池不可用，请联系管理员");
        return selected;
    }
    const row = rows[Number(BigInt(policy.cursor) % BigInt(rows.length))];
    await db.query("UPDATE canvas_storage_policy SET cursor=cursor+1 WHERE id=true");
    return row;
}
export async function poolReferenced(db: Database, id: string) {
    return (await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM canvas_media WHERE pool_id=$1)
        OR EXISTS(SELECT 1 FROM canvas_public_media WHERE pool_id=$1)
        OR EXISTS(SELECT 1 FROM canvas_storage_tasks WHERE source_pool_id=$1 OR target_pool_id=$1)
        OR EXISTS(SELECT 1 FROM canvas_storage_task_items WHERE source_pool_id=$1 OR target_pool_id=$1)
        OR EXISTS(SELECT 1 FROM canvas_storage_backups WHERE (source_pool_id=$1 OR target_pool_id=$1) AND status<>'deleted')`, [id])).rowCount! > 0;
}
export function publicPool(row: PoolRow & { media_count?: string; used_bytes?: string; backup_bytes?: string }) {
    return { id: row.id, name: row.name, provider: row.provider, endpoint: row.endpoint, publicEndpoint: row.public_endpoint, region: row.region, bucket: row.bucket, prefix: row.prefix, pathStyle: row.path_style, writable: row.writable, capacityBytes: row.capacity_bytes === null ? null : Number(row.capacity_bytes), revision: Number(row.revision), hasCredentials: !!row.credentials, mediaCount: Number(row.media_count || 0), usedBytes: Number(row.used_bytes || 0), backupBytes: Number(row.backup_bytes || 0) };
}
