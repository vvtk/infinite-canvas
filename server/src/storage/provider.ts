import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import OSS from "ali-oss";
import type { StorageProvider } from "../../../shared/storage.js";
import { fail } from "../management.js";

export type PoolRow = {
    id: string; name: string; provider: StorageProvider; endpoint: string; public_endpoint: string;
    region: string; bucket: string; prefix: string; path_style: boolean; writable: boolean; capacity_bytes: string | null;
    credentials: string; revision: string | number;
};
export type MediaContent = { bytes: number; sha256: string; mimeType: string };
export type StorageClient = {
    read: (key: string) => Promise<Readable>;
    put: (key: string, body: Readable | Buffer, bytes: number, mimeType: string) => Promise<void>;
    remove: (key: string) => Promise<void>;
    test: () => Promise<void>;
    upload: (key: string, content: MediaContent, seconds: number) => Promise<{ url: string; fields: Record<string, string> }>;
    url: (key: string, seconds: number) => Promise<string>;
    close: () => void;
};
export function storageClient(row: PoolRow, credentials: { accessKey: string; secretKey: string }): StorageClient {
    if (row.provider === "oss") {
        const options = { accessKeyId: credentials.accessKey, accessKeySecret: credentials.secretKey, region: row.region, bucket: row.bucket, authorizationV4: true };
        const client = new OSS({ ...options, endpoint: row.endpoint });
        const external = new OSS({ ...options, endpoint: row.public_endpoint });
        return {
            read: async key => (await client.getStream(key)).stream as Readable,
            put: async (key, body, bytes, mimeType) => { await client.putStream(key, Buffer.isBuffer(body) ? Readable.from([body]) : body, { contentLength: bytes, mime: mimeType }); },
            remove: async key => { await client.delete(key); },
            test: async () => { await client.getBucketInfo(row.bucket); },
            url: (key, seconds) => external.signatureUrlV4("GET", seconds, undefined, key),
            upload: async (key, content, seconds) => {
                const now = new Date(), date = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
                const fields: Record<string, string> = {
                    key, "Content-Type": content.mimeType, success_action_status: "200",
                    "x-oss-date": date, "x-oss-signature-version": "OSS4-HMAC-SHA256",
                    "x-oss-credential": `${credentials.accessKey}/${date.slice(0, 8)}/${row.region.replace(/^oss-/, "")}/oss/aliyun_v4_request`,
                };
                const policy = { expiration: new Date(now.getTime() + seconds * 1000).toISOString(), conditions: [{ bucket: row.bucket }, ...Object.entries(fields).map(([name, value]) => ({ [name]: value })), ["content-length-range", content.bytes, content.bytes]] };
                const signer = external as OSS & { signPostObjectPolicyV4: (policy: object, date: Date) => string };
                return { url: external.generateObjectUrl(""), fields: { ...fields, policy: Buffer.from(JSON.stringify(policy)).toString("base64"), "x-oss-signature": signer.signPostObjectPolicyV4(policy, now) } };
            },
            close: () => {},
        };
    }
    const options = { region: row.region, forcePathStyle: row.path_style, credentials: { accessKeyId: credentials.accessKey, secretAccessKey: credentials.secretKey } };
    const client = new S3Client({ ...options, endpoint: row.endpoint });
    const external = new S3Client({ ...options, endpoint: row.public_endpoint });
    return {
        read: async key => {
            const result = await client.send(new GetObjectCommand({ Bucket: row.bucket, Key: key }));
            if (!result.Body) fail(400, "存储对象缺失");
            return result.Body as Readable;
        },
        put: async (key, body, bytes, mimeType) => { await client.send(new PutObjectCommand({ Bucket: row.bucket, Key: key, Body: body, ContentLength: bytes, ContentType: mimeType })); },
        remove: async key => { await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: key })); },
        test: async () => { await client.send(new HeadBucketCommand({ Bucket: row.bucket })); },
        upload: (key, content, seconds) => {
            const checksum = Buffer.from(content.sha256, "hex").toString("base64");
            return createPresignedPost(external, { Bucket: row.bucket, Key: key, Expires: seconds,
                Fields: { "Content-Type": content.mimeType, "x-amz-checksum-algorithm": "SHA256", "x-amz-checksum-sha256": checksum },
                Conditions: [["content-length-range", content.bytes, content.bytes], ["eq", "$Content-Type", content.mimeType], ["eq", "$x-amz-checksum-algorithm", "SHA256"], ["eq", "$x-amz-checksum-sha256", checksum]],
            });
        },
        url: (key, seconds) => getSignedUrl(external, new GetObjectCommand({ Bucket: row.bucket, Key: key, ResponseContentDisposition: "attachment" }), { expiresIn: seconds }),
        close: () => { client.destroy(); external.destroy(); },
    };
}
export async function verifyObject(client: StorageClient, key: string, content: Pick<MediaContent, "bytes" | "sha256">) {
    const body = await client.read(key), hash = createHash("sha256");
    let bytes = 0;
    try {
        for await (const chunk of body) { bytes += chunk.length; if (bytes > content.bytes) fail(400, "媒体大小或校验和不匹配"); hash.update(chunk); }
        if (bytes !== content.bytes || hash.digest("hex") !== content.sha256) fail(400, "媒体大小或校验和不匹配");
    } finally { body.destroy(); }
}
export async function copyObject(source: StorageClient, target: StorageClient, sourceKey: string, targetKey: string, content: MediaContent) {
    const body = await source.read(sourceKey), hash = createHash("sha256");
    let bytes = 0;
    const checked = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > content.bytes) return callback(new Error("源媒体大小不匹配"));
        hash.update(chunk); callback(null, chunk);
    } });
    const transfer = pipeline(body, checked);
    try {
        await Promise.all([transfer, target.put(targetKey, checked, content.bytes, content.mimeType)]);
        if (bytes !== content.bytes || hash.digest("hex") !== content.sha256) fail(400, "源媒体校验失败");
        await verifyObject(target, targetKey, content);
    } finally { body.destroy(); checked.destroy(); }
}
