import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { RestoreEntry } from "../../../shared/storage.js";
import type { Config } from "../config.js";
import { digest } from "../crypto.js";
import { fail, readSettings, storageQuota, storageUsage } from "../management.js";
import { clientFor, type Database } from "./pools.js";

const mediaSchema = z.object({
    kind: z.enum(["private", "public"]), id: z.string().min(1), userId: z.string().nullable(), storageKey: z.string().nullable(),
    poolId: z.string().min(1), objectKey: z.string().min(1), backupKey: z.string().min(1),
    bytes: z.number().int().positive().safe(), sha256: z.string().regex(/^[a-f\d]{64}$/), mimeType: z.string(),
});
const recordSnapshot = z.object({ userId: z.string(), domain: z.enum(["canvas", "assets", "image-workbench", "video-workbench"]), id: z.string(), revision: z.number().int().positive(), data: z.record(z.string(), z.unknown()), media: z.array(z.string()) });
const librarySnapshot = z.object({ id: z.string(), kind: z.enum(["prompts", "tutorials", "skills", "assets"]), revision: z.number().int().positive(), data: z.record(z.string(), z.unknown()), position: z.number() });
export const manifestSchema = z.object({
    version: z.literal(1), id: z.string(), sourcePoolId: z.string(), createdAt: z.string(),
    media: z.array(mediaSchema), records: z.array(recordSnapshot), library: z.array(librarySnapshot), logoUrl: z.string().nullable(),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type MediaSnapshot = Manifest["media"][number];
export const recordKey = (row: Pick<Manifest["records"][number], "userId" | "domain" | "id">) => JSON.stringify([row.userId, row.domain, row.id]);
export const libraryKey = (id: string) => JSON.stringify(["library", id]);
export function publicMediaIds(value: unknown, ids = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return ids;
    for (const [key, child] of Object.entries(value)) {
        if (key === "mediaId" && typeof child === "string" && child) ids.add(child);
        if (typeof child === "string" && /^\/api\/library\/media\/[^/?#]+$/.test(child)) ids.add(child.split("/").pop()!);
        else publicMediaIds(child, ids);
    }
    return ids;
}
export function validateManifest(value: unknown): Manifest {
    const manifest = manifestSchema.parse(value), media = new Map<string, MediaSnapshot>();
    for (const item of manifest.media) {
        const key = `${item.kind}/${item.id}`;
        if (media.has(key) || (item.kind === "private" ? !item.userId || !item.storageKey : item.userId !== null || item.storageKey !== null)) fail(400, "备份媒体清单损坏");
        media.set(key, item);
    }
    const keys = new Set<string>();
    for (const record of manifest.records) {
        const key = recordKey(record);
        if (keys.has(key) || record.data.id !== record.id) fail(400, "备份业务记录身份无效");
        keys.add(key);
        for (const id of record.media) if (media.get(`private/${id}`)?.userId !== record.userId) fail(400, "备份包含缺失或越权媒体");
    }
    for (const record of manifest.library) {
        const key = libraryKey(record.id);
        if (keys.has(key)) fail(400, "备份公共记录重复");
        keys.add(key);
        for (const id of publicMediaIds(record.data)) if (!media.has(`public/${id}`)) fail(400, "备份公共媒体依赖缺失");
    }
    if (manifest.logoUrl && !media.has(`public/${manifest.logoUrl.split("/").pop()}`)) fail(400, "备份 Logo 依赖缺失");
    return manifest;
}
export async function snapshotBackup(db: Database, sourcePoolId: string, id: string, backupPrefix: string): Promise<Manifest> {
    // The caller uses REPEATABLE READ; no remote I/O happens inside this snapshot transaction.
    const privateMedia = (await db.query("SELECT * FROM canvas_media WHERE ready")).rows;
    const publicMedia = (await db.query("SELECT * FROM canvas_public_media WHERE ready")).rows;
    const privateIds = privateMedia.filter(row => row.pool_id === sourcePoolId).map(row => row.id);
    const sourcePublic = new Set(publicMedia.filter(row => row.pool_id === sourcePoolId).map(row => row.id));
    const records = (await db.query("SELECT * FROM canvas_records WHERE NOT deleted AND media ?| $1::text[]", [privateIds])).rows.map(row => ({ userId: row.user_id, domain: row.domain, id: row.id, revision: Number(row.revision), data: row.data, media: row.media }));
    const selectedPrivate = new Set(privateIds);
    for (const row of records) for (const mediaId of row.media) selectedPrivate.add(mediaId);
    const library = (await db.query("SELECT * FROM canvas_library WHERE NOT deleted")).rows.filter(row => [...publicMediaIds({ ...row.remote_data, ...row.data })].some(mediaId => sourcePublic.has(mediaId))).map(row => ({ id: row.id, kind: row.kind, revision: Number(row.revision), data: { ...row.remote_data, ...row.data }, position: Number(row.position) }));
    const selectedPublic = new Set(sourcePublic);
    for (const row of library) for (const mediaId of publicMediaIds(row.data)) selectedPublic.add(mediaId);
    const logo = (await db.query("SELECT data->>'logoUrl' AS url FROM canvas_site_settings WHERE id=true")).rows[0]?.url || "";
    const media: MediaSnapshot[] = [];
    for (const [kind, rows, selected] of [["private", privateMedia, selectedPrivate], ["public", publicMedia, selectedPublic]] as const) {
        for (const row of rows) if (selected.has(row.id)) {
            if (!row.pool_id) fail(409, "存在未关联存储池的媒体");
            media.push({ kind, id: row.id, userId: kind === "private" ? row.user_id : null, storageKey: kind === "private" ? row.storage_key : null, poolId: row.pool_id, objectKey: row.object_key, backupKey: `${backupPrefix}/${kind}/${row.id}`, bytes: Number(row.bytes), sha256: row.sha256, mimeType: row.mime_type });
        }
    }
    return validateManifest({ version: 1, id, sourcePoolId, createdAt: new Date().toISOString(), media, records, library, logoUrl: sourcePublic.has(logo.split("/").pop()) ? logo : null });
}
export async function readBackup(db: Database, config: Config, id: string) {
    const backup = (await db.query("SELECT * FROM canvas_storage_backups WHERE id=$1 AND status='ready'", [id])).rows[0];
    if (!backup) fail(404, "备份不存在或尚未完成");
    const client = await clientFor(db, config, backup.target_pool_id);
    try {
        const stream = await client.read(backup.manifest_key), chunks: Buffer[] = [];
        let bytes = 0;
        try {
            for await (const chunk of stream) { bytes += chunk.length; if (bytes > Number(backup.manifest_bytes)) fail(400, "备份清单大小不匹配"); chunks.push(Buffer.from(chunk)); }
        } finally { stream.destroy(); }
        const buffer = Buffer.concat(chunks);
        if (bytes !== Number(backup.manifest_bytes) || digest(buffer) !== backup.manifest_sha256) fail(400, "备份清单校验失败");
        const manifest = validateManifest(JSON.parse(buffer.toString("utf8")));
        if (manifest.id !== backup.id || !isDeepStrictEqual(manifest, backup.manifest)) fail(400, "备份清单与数据库不一致");
        return { backup, manifest };
    } finally { client.close(); }
}
export async function restoreState(db: Database, manifest: Manifest) {
    const entries: RestoreEntry[] = [];
    for (const record of manifest.records) {
        const row = (await db.query("SELECT revision FROM canvas_records WHERE user_id=$1 AND domain=$2 AND id=$3", [record.userId, record.domain, record.id])).rows[0];
        entries.push({ key: recordKey(record), label: String(record.data.title || record.data.name || record.id), kind: "record", userId: record.userId, state: row ? "conflict" : "missing", revision: row ? Number(row.revision) : null });
    }
    for (const record of manifest.library) {
        const row = (await db.query("SELECT revision FROM canvas_library WHERE id=$1", [record.id])).rows[0];
        entries.push({ key: libraryKey(record.id), label: String(record.data.title || record.id), kind: "library", state: row ? "conflict" : "missing", revision: row ? Number(row.revision) : null });
    }
    if (manifest.logoUrl) {
        const row = (await db.query("SELECT revision FROM canvas_site_settings WHERE id=true")).rows[0];
        entries.push({ key: "logo", label: "站点 Logo", kind: "logo", state: "conflict", revision: Number(row.revision) });
    }
    return entries;
}
export async function previewRestore(db: Database, config: Config, id: string, manifest: Manifest) {
    const entries = await restoreState(db, manifest), usage = [];
    for (const userId of [...new Set(manifest.media.filter(item => item.kind === "private").map(item => item.userId!))]) {
        const user = (await db.query("SELECT profile FROM canvas_users WHERE id=$1", [userId])).rows[0];
        if (!user) fail(409, "备份关联账号不存在，不能恢复到其他账号");
        let added = 0;
        for (const item of manifest.media.filter(item => item.userId === userId)) {
            const current = (await db.query("SELECT bytes FROM canvas_media WHERE id=$1 AND (ready OR expires_at>now())", [item.id])).rows[0];
            added += Math.max(0, item.bytes - Number(current?.bytes || 0));
        }
        for (const record of manifest.records.filter(item => item.userId === userId)) {
            const sizes = (await db.query("SELECT octet_length($4::jsonb::text) - COALESCE((SELECT octet_length(data::text) FROM canvas_records WHERE user_id=$1 AND domain=$2 AND id=$3 AND NOT deleted),0) AS bytes", [userId, record.domain, record.id, JSON.stringify(record.data)])).rows[0];
            added += Math.max(0, Number(sizes.bytes));
        }
        usage.push({ userId, username: String(user.profile.displayName || user.profile.username || userId), usedBytes: await storageUsage(db, userId), quotaBytes: await storageQuota(db, config, userId), estimatedAddedBytes: added });
    }
    const previewId = randomUUID();
    if (!(await db.query("INSERT INTO canvas_storage_restore_previews(id,backup_id,manifest_sha256,data) SELECT $1,id,manifest_sha256,$3 FROM canvas_storage_backups WHERE id=$2 AND status='ready'", [previewId, id, JSON.stringify({ entries })])).rowCount) fail(409, "备份已变化，请刷新后重新预览");
    return { id: previewId, backupId: id, entries, usage };
}
export async function assertRestoreRevisions(db: Database, manifest: Manifest, expected: RestoreEntry[], selected: string[]) {
    const current = new Map((await restoreState(db, manifest)).map(item => [item.key, item]));
    const previous = new Map(expected.map(item => [item.key, item]));
    for (const key of selected) {
        if (!previous.has(key) || !current.has(key)) fail(400, "恢复选择无效");
        if (previous.get(key)!.revision !== current.get(key)!.revision) fail(409, "记录在预览后已变化，请重新预览");
    }
}
export async function assertRestoreQuota(db: Database, config: Config, manifest: Manifest, selected: string[]) {
    for (const userId of [...new Set(manifest.media.filter(item => item.kind === "private").map(item => item.userId!))]) {
        if (!(await db.query("SELECT id FROM canvas_users WHERE id=$1", [userId])).rowCount) fail(409, "备份关联账号不存在");
        let change = 0;
        for (const item of manifest.media.filter(item => item.userId === userId)) {
            const current = (await db.query("SELECT bytes FROM canvas_media WHERE id=$1 AND (ready OR expires_at>now())", [item.id])).rows[0];
            change += item.bytes - Number(current?.bytes || 0);
        }
        for (const record of manifest.records.filter(item => item.userId === userId && selected.includes(recordKey(item)))) {
            const row = (await db.query("SELECT octet_length($4::jsonb::text) - COALESCE((SELECT octet_length(data::text) FROM canvas_records WHERE user_id=$1 AND domain=$2 AND id=$3 AND NOT deleted),0) AS bytes", [userId, record.domain, record.id, JSON.stringify(record.data)])).rows[0];
            change += Number(row.bytes);
        }
        if (change > 0 && await storageUsage(db, userId) + change > await storageQuota(db, config, userId)) fail(413, "恢复后云存储额度不足，未修改在线数据");
    }
}
