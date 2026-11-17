import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Session } from "./auth.js";
import { digest } from "./crypto.js";
import { transaction } from "./db.js";
import { fail, requireCloudStorage, storageQuota, storageUsage } from "./management.js";
import { chooseWritePool, clientFor, objectKey } from "./storage/pools.js";
import { verifyObject } from "./storage/provider.js";

export function mediaRoutes(app: FastifyInstance, pool: Pool, config: Config, requireSession: (request: FastifyRequest) => Promise<Session>) {
    app.post("/api/media/uploads", async (request) => {
        const { userId } = await requireSession(request);
        const input = z.object({ storageKey: z.string().min(1), bytes: z.number().int().positive().max(config.MAX_MEDIA_BYTES), mimeType: z.string().min(1), sha256: z.string().regex(/^[a-f\d]{64}$/) }).parse(request.body);
        const id = digest(`${userId}\n${input.storageKey}`);
        return transaction(pool, async (db) => {
            await requireCloudStorage(db, config);
            await db.query("SELECT id FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
            const existing = await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2", [id, userId]);
            if (existing.rowCount) {
                const item = existing.rows[0];
                if (item.sha256 !== input.sha256 || Number(item.bytes) !== input.bytes) throw Object.assign(new Error("媒体标识已对应其他内容"), { statusCode: 409 });
                if (item.ready) return { id, ready: true };
            }
            // Expired reservations don't count. Completed objects always count.
            const used = await db.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM canvas_media WHERE user_id=$1 AND id<>$2 AND (ready OR expires_at>now())) + (SELECT COALESCE(SUM(octet_length(data::text)),0) FROM canvas_records WHERE user_id=$1 AND NOT deleted) AS bytes", [userId, id]);
            if (Number(used.rows[0].bytes) + input.bytes > await storageQuota(db,config,userId) && Number(used.rows[0].bytes) + input.bytes > await storageUsage(db,userId)) throw Object.assign(new Error("云存储额度不足，本地数据已保留"), { statusCode: 413 });
            const existingItem = existing.rows[0];
            const selected = existingItem ? null : await chooseWritePool(db);
            const poolId = existingItem?.pool_id || selected?.id;
            if (!poolId) fail(409, "媒体尚未关联存储池，请联系管理员");
            const key = existingItem?.object_key || objectKey(selected!, `${userId}/${id}`);
            const destination = await db.query("SELECT writable FROM canvas_storage_pools WHERE id=$1 FOR SHARE", [poolId]);
            if (!destination.rows[0]?.writable) fail(409, "原上传池已停止写入，本地文件已保留");
            const client = await clientFor(db, config, poolId);
            try {
                const upload = await client.upload(key, input, config.MEDIA_URL_SECONDS);
                await db.query("INSERT INTO canvas_media(id,user_id,storage_key,object_key,bytes,mime_type,sha256,ready,expires_at,pool_id) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9) ON CONFLICT(id) DO UPDATE SET expires_at=$8", [id, userId, input.storageKey, key, input.bytes, input.mimeType, input.sha256, new Date(Date.now() + config.MEDIA_URL_SECONDS * 1000), poolId]);
                return { id, ready: false, upload };
            } finally { client.close(); }
        });
    });
    app.post("/api/media/:id/complete", async (request) => {
        const { userId } = await requireSession(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        await transaction(pool, async (db) => {
        await requireCloudStorage(db, config);
        await db.query("SELECT id FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
        const item = (await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2 AND (ready OR expires_at>now()) FOR UPDATE", [id, userId])).rows[0];
        if (!item) throw Object.assign(new Error("上传不存在或已过期"), { statusCode: 404 });
        const client = await clientFor(db, config, item.pool_id);
        try { await verifyObject(client, item.object_key, { bytes: Number(item.bytes), sha256: item.sha256 }); }
        finally { client.close(); }
        await db.query("UPDATE canvas_media SET ready=true WHERE id=$1 AND user_id=$2", [id, userId]);
        });
        return { id, ready: true };
    });
    app.get("/api/media/:id/url", async (request, reply) => {
        const { userId } = await requireSession(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        return transaction(pool, async db => {
            await requireCloudStorage(db, config);
            const item = (await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2 AND ready FOR SHARE", [id, userId])).rows[0];
            if (!item) fail(404, "媒体不存在");
            reply.header("Cache-Control", "no-store");
            const client = await clientFor(db, config, item.pool_id);
            try { return { storageKey: item.storage_key, mimeType: item.mime_type, url: await client.url(item.object_key, config.MEDIA_URL_SECONDS) }; }
            finally { client.close(); }
        });
    });
    app.get("/api/media/:id/content", async (request, reply) => {
        const { userId } = await requireSession(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        return transaction(pool, async db => {
            await requireCloudStorage(db, config);
            const item = (await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2 AND ready FOR SHARE", [id, userId])).rows[0];
            if (!item) fail(404, "媒体不存在");
            const client = await clientFor(db, config, item.pool_id);
            let stream: Awaited<ReturnType<typeof client.read>>;
            try { stream = await client.read(item.object_key); } catch (error) { client.close(); throw error; }
            let released = false;
            const release = () => { if (!released) { released = true; client.close(); } };
            stream.once("end", release).once("error", release);
            reply.raw.once("close", release);
            return reply.type(item.mime_type).header("Content-Length", String(item.bytes)).header("Cache-Control", "private, max-age=600").send(stream);
        });
    });
}
