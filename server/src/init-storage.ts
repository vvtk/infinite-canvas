import { S3Client, CreateBucketCommand, PutBucketCorsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { readConfig } from "./config.js";
const config = readConfig();
if (!config.S3_ENDPOINT || !config.S3_PUBLIC_ENDPOINT || !config.S3_REGION || !config.S3_BUCKET || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY) throw new Error("此初始化脚本需要完整的 S3 环境配置；后台添加的存储池请在对应服务配置 Bucket 和 CORS");
const client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } });
try {
    try { await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
    catch (error) {
        if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET, ...(config.S3_REGION === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: config.S3_REGION as "eu-west-1" } }) }));
    }
    await client.send(new PutBucketCorsCommand({ Bucket: config.S3_BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [new URL(config.PUBLIC_URL).origin], AllowedMethods: ["GET", "POST", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"] }] } }));
} finally { client.destroy(); }
