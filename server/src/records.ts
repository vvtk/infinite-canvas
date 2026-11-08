import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.js";
import type { Session } from "./auth.js";
import type { Config } from "./config.js";

export const recordSchema = z.object({
    domain: z.enum(["canvas", "assets", "image-workbench", "video-workbench"]), id: z.string().min(1),
    baseRevision: z.number().int().nonnegative(), deleted: z.boolean(), data: z.record(z.string(), z.unknown()).nullable(), media: z.array(z.string()),
}).refine((record) => record.deleted ? record.data === null : record.data?.id === record.id, "Record identity mismatch");
export function rejectSecrets(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (/^(api.?key|access.?token|refresh.?token|password|authorization|preview|previewUrl|thumbnail)$/i.test(key)) throw Object.assign(new Error("云记录不能包含密钥或本地预览"), { statusCode: 400 });
        rejectSecrets(child);
    }
}
export function recordRoutes(app: FastifyInstance, pool: Pool, config: Config, requireSession: (request: FastifyRequest) => Promise<Session>) {
    app.get("/api/sync/changes", async (request) => {
        const { userId } = await requireSession(request);
        const { cursor } = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
        return transaction(pool, async (db) => {
            // Read a consistent watermark; writes use the same user lock.
            const user = await db.query("SELECT revision FROM canvas_users WHERE id=$1 FOR SHARE", [userId]);
            const rows = await db.query("SELECT domain,id,revision,deleted,data,media FROM canvas_records WHERE user_id=$1 AND revision>$2 ORDER BY revision", [userId, cursor]);
            return { cursor: Number(user.rows[0].revision), records: rows.rows.map((row) => ({ ...row, revision: Number(row.revision) })) };
        });
    });
    app.post("/api/sync/records", async (request, reply) => {
        const { userId } = await requireSession(request);
        const record = recordSchema.parse(request.body);
        rejectSecrets(record.data);
        const result = await transaction(pool, async (db) => {
            const user = await db.query("SELECT revision FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
            const existing = await db.query("SELECT domain,id,revision,deleted,data,media FROM canvas_records WHERE user_id=$1 AND domain=$2 AND id=$3", [userId, record.domain, record.id]);
            const remote = existing.rows[0];
            if (Number(remote?.revision || 0) !== record.baseRevision) return { conflict: remote ? { ...remote, revision: Number(remote.revision) } : null };
            if (record.media.length) {
                const ready = await db.query("SELECT id FROM canvas_media WHERE user_id=$1 AND ready AND id=ANY($2::text[])", [userId, record.media]);
                if (ready.rowCount !== new Set(record.media).size) throw Object.assign(new Error("引用媒体尚未上传或无权访问"), { statusCode: 400 });
            }
            if (!record.deleted) {
                const usage = await db.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM canvas_media WHERE user_id=$1 AND (ready OR expires_at>now())) + (SELECT COALESCE(SUM(octet_length(data::text)),0) FROM canvas_records WHERE user_id=$1 AND NOT deleted AND NOT(domain=$2 AND id=$3)) + octet_length($4::jsonb::text) AS bytes", [userId, record.domain, record.id, JSON.stringify(record.data)]);
                if (Number(usage.rows[0].bytes)>config.USER_STORAGE_BYTES) throw Object.assign(new Error("云存储额度不足，本地数据已保留"), { statusCode: 413 });
            }
            const revision = Number(user.rows[0].revision) + 1;
            await db.query("UPDATE canvas_users SET revision=$2 WHERE id=$1", [userId, revision]);
            await db.query("INSERT INTO canvas_records VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,domain,id) DO UPDATE SET revision=$4,deleted=$5,data=$6,media=$7", [userId, record.domain, record.id, revision, record.deleted, record.deleted ? null : record.data, JSON.stringify(record.deleted ? [] : [...new Set(record.media)])]);
            return { revision };
        });
        return "conflict" in result ? reply.code(409).send(result) : result;
    });
}
