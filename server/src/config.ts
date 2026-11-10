import { z } from "zod";

export function readConfig(env = process.env) {
    const positive = z.coerce.number().int().positive();
    const config = z.object({
        PUBLIC_URL: z.url(), LLMROAM_URL: z.url(), OAUTH_AUTHORIZE_URL: z.url().optional(), OAUTH_CLIENT_ID: z.string().min(1), OAUTH_CLIENT_SECRET: z.string().min(32),
        DATABASE_URL: z.string().min(1), ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
        S3_ENDPOINT: z.url(), S3_PUBLIC_ENDPOINT: z.url(), S3_REGION: z.string().min(1), S3_BUCKET: z.string().min(1),
        S3_ACCESS_KEY: z.string().min(1), S3_SECRET_KEY: z.string().min(1),
        MAX_MEDIA_BYTES: positive.default(536870912), USER_STORAGE_BYTES: positive.default(2147483648), SESSION_SECONDS: positive.default(2592000), MEDIA_URL_SECONDS: positive.default(600),
        OAUTH_FLOW_SECONDS: positive.default(300),
        PORT: positive.default(3001), HOST: z.string().default("127.0.0.1"),
    }).parse(env);
    const normalized = { ...config, OAUTH_AUTHORIZE_URL: config.OAUTH_AUTHORIZE_URL || new URL("/api/oauth-provider/authorize", config.LLMROAM_URL).href };
    for (const [key, value] of Object.entries({ PUBLIC_URL: normalized.PUBLIC_URL, LLMROAM_URL: normalized.LLMROAM_URL })) {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${key} must be an HTTP(S) URL`);
        if (key === "PUBLIC_URL" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
            throw new Error("PUBLIC_URL requires HTTPS outside localhost");
        }
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Expected an origin URL");
    }
    const authorizeUrl = new URL(normalized.OAUTH_AUTHORIZE_URL);
    if (!["http:", "https:"].includes(authorizeUrl.protocol) || authorizeUrl.username || authorizeUrl.password || authorizeUrl.hash) throw new Error("OAUTH_AUTHORIZE_URL must be an HTTP(S) URL without credentials or fragments");
    return normalized;
}
export type Config = ReturnType<typeof readConfig>;
