import { S3Client, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Session } from "./auth.js";
import { digest } from "./crypto.js";
import { transaction } from "./db.js";

export function mediaRoutes(app: FastifyInstance, pool: Pool, config: Config, requireSession: (request: FastifyRequest) => Promise<Session>) {
    const options = { region: config.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } };
    const s3 = new S3Client({ ...options, endpoint: config.S3_ENDPOINT });
    const publicS3 = new S3Client({ ...options, endpoint: config.S3_PUBLIC_ENDPOINT });
    app.post("/api/media/uploads", async (request) => {
        const { userId } = await requireSession(request);
        const input = z.object({ storageKey: z.string().min(1), bytes: z.number().int().positive().max(config.MAX_MEDIA_BYTES), mimeType: z.string().min(1), sha256: z.string().regex(/^[a-f\d]{64}$/) }).parse(request.body);
        const id = digest(`${userId}\n${input.storageKey}`);
        const objectKey = `${userId}/${id}`;
        const ready = await transaction(pool, async (db) => {
            await db.query("SELECT id FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
            const existing = await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2", [id, userId]);
            if (existing.rowCount) {
                const item = existing.rows[0];
                if (item.sha256 !== input.sha256 || Number(item.bytes) !== input.bytes) throw Object.assign(new Error("媒体标识已对应其他内容"), { statusCode: 409 });
                if (item.ready) return true;
            }
            // Expired reservations don't count. Completed objects always count.
            const used = await db.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM canvas_media WHERE user_id=$1 AND id<>$2 AND (ready OR expires_at>now())) + (SELECT COALESCE(SUM(octet_length(data::text)),0) FROM canvas_records WHERE user_id=$1 AND NOT deleted) AS bytes", [userId, id]);
            if (Number(used.rows[0].bytes) + input.bytes > config.USER_STORAGE_BYTES) throw Object.assign(new Error("云存储额度不足，本地数据已保留"), { statusCode: 413 });
            await db.query("INSERT INTO canvas_media VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) ON CONFLICT(id) DO UPDATE SET expires_at=$8", [id, userId, input.storageKey, objectKey, input.bytes, input.mimeType, input.sha256, new Date(Date.now() + config.MEDIA_URL_SECONDS * 1000)]);
            return false;
        });
        if (ready) return { id, ready: true };
        const checksum = Buffer.from(input.sha256, "hex").toString("base64");
        const upload = await createPresignedPost(publicS3, {
            Bucket: config.S3_BUCKET, Key: objectKey, Expires: config.MEDIA_URL_SECONDS,
            Fields: { "Content-Type": input.mimeType, "x-amz-checksum-algorithm": "SHA256", "x-amz-checksum-sha256": checksum },
            Conditions: [["content-length-range", input.bytes, input.bytes], ["eq", "$Content-Type", input.mimeType], ["eq", "$x-amz-checksum-algorithm", "SHA256"], ["eq", "$x-amz-checksum-sha256", checksum]],
        });
        return { id, ready: false, upload };
    });
    app.post("/api/media/:id/complete", async (request) => {
        const { userId } = await requireSession(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        await transaction(pool, async (db) => {
        await db.query("SELECT id FROM canvas_users WHERE id=$1 FOR UPDATE", [userId]);
        const item = (await db.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2 AND (ready OR expires_at>now())", [id, userId])).rows[0];
        if (!item) throw Object.assign(new Error("上传不存在或已过期"), { statusCode: 404 });
        const head = await s3.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: item.object_key, ChecksumMode: "ENABLED" }));
        if (Number(head.ContentLength) !== Number(item.bytes) || head.ChecksumSHA256 !== Buffer.from(item.sha256, "hex").toString("base64")) throw Object.assign(new Error("媒体大小或校验和不匹配"), { statusCode: 400 });
        await db.query("UPDATE canvas_media SET ready=true WHERE id=$1 AND user_id=$2", [id, userId]);
        });
        return { id, ready: true };
    });
    app.get("/api/media/:id/url", async (request, reply) => {
        const { userId } = await requireSession(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const item = (await pool.query("SELECT * FROM canvas_media WHERE id=$1 AND user_id=$2 AND ready", [id, userId])).rows[0];
        if (!item) throw Object.assign(new Error("媒体不存在"), { statusCode: 404 });
        reply.header("Cache-Control", "no-store");
        return { storageKey: item.storage_key, mimeType: item.mime_type, url: await getSignedUrl(publicS3, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: item.object_key, ResponseContentDisposition: "attachment" }), { expiresIn: config.MEDIA_URL_SECONDS }) };
    });
    app.addHook("onClose", async () => { s3.destroy(); publicS3.destroy(); });
}
