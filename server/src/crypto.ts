import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");
export function encrypt(value: unknown, key: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64");
}
export function decrypt<T>(value: string, key: string): T {
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as T;
}
export function localReturnPath(value: unknown) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
    const url = new URL(value, "https://canvas.invalid");
    return url.origin === "https://canvas.invalid" && !url.pathname.startsWith("/api/") ? url.pathname + url.search : "/";
}
