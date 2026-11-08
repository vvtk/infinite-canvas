import { S3Client, CreateBucketCommand, PutBucketCorsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { readConfig } from "./config.js";
const config = readConfig();
const client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } });
try {
    try { await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
    catch (error) {
        if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET, ...(config.S3_REGION === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: config.S3_REGION as "eu-west-1" } }) }));
    }
    await client.send(new PutBucketCorsCommand({ Bucket: config.S3_BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [new URL(config.PUBLIC_URL).origin], AllowedMethods: ["GET", "POST", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"] }] } }));
} finally { client.destroy(); }
