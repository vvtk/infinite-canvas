import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { Config } from "./config.js";
import { workflowSchema } from "./tutorial-workflow.js";

type Database = Pick<Pool | PoolClient, "query">;
export const resourceKinds = ["prompts", "tutorials", "skills", "assets"] as const;
export type ResourceKind = typeof resourceKinds[number];
export const httpUrl = z.string().refine((value) => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "地址必须为 HTTP(S) URL");
const mediaUrl = z.union([httpUrl, z.string().regex(/^\/api\/library\/media\/[a-f0-9-]+$/), z.literal("")]);
const title = z.string().trim().min(1);
const common = { title, description: z.string().default(""), coverUrl: mediaUrl.default(""), tags: z.array(z.string()).default([]), category: z.string().default("") };
export const contentSchemas = {
    prompts: z.object({ ...common, prompt: title, referenceImageUrls: z.array(httpUrl).default([]), author: z.string().default(""), sourceUrl: z.union([httpUrl,z.literal("")]).default("") }),
    tutorials: z.object({ ...common, format: z.enum(["markdown", "link", "workflow"]), content: z.string().default(""), href: z.union([httpUrl,z.string().regex(/^\/(?!\/)[^\\]*$/),z.literal("")]).default(""), workflow: workflowSchema.optional() }).refine((data) => data.format === "workflow" ? !!data.workflow : data.format === "markdown" ? !!data.content.trim() : !!data.href, "请填写正文、教程链接或节点流程").refine(data => data.format === "workflow" || !data.workflow, "只有节点流程教程可以包含流程数据"),
    skills: z.object({ ...common, title: title.max(64), name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description:z.string().trim().min(1).max(1024).refine(value=>!/[<>]/.test(value)), instructions: title, defaultPrompt: z.string().max(1024).default("") }).refine(data=>!data.defaultPrompt||new RegExp(`\\$${data.name}(?![A-Za-z0-9_-]|:[A-Za-z0-9_-])`).test(data.defaultPrompt),"默认提示词应包含 $技能标识"),
    assets: z.object({ ...common, assetKind: z.enum(["text","image","video"]), content: z.string().default(""), mediaId: z.string().default(""), width: z.number().nonnegative().default(0), height: z.number().nonnegative().default(0), bytes: z.number().nonnegative().default(0), mimeType: z.string().default("") }).refine((data) => data.assetKind === "text" ? !!data.content.trim() : !!data.mediaId, "请填写文本或上传素材"),
};
export const settingsSchema = z.object({
    siteName: title, description: z.string(), logoUrl: mediaUrl, announcement: z.string(),
    hidePrivateChannels: z.boolean().default(false),
    userCloudStorageEnabled: z.boolean().default(true),
    publicContent: z.object({ prompts: z.boolean(), tutorials: z.boolean(), skills: z.boolean(), assets: z.boolean() }),
    defaultStorageBytes: z.number().int().positive().safe(),
    promptSyncMinutes: z.union([z.literal(0),z.literal(30),z.literal(60),z.literal(360),z.literal(1440)]),
});
export type SiteSettings = z.infer<typeof settingsSchema>;
export const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };
export async function readSettings(db: Database, config: Config): Promise<SiteSettings> {
    const row = (await db.query("SELECT data FROM canvas_site_settings WHERE id=true")).rows[0];
    return row?.data ? settingsSchema.parse(row.data) : { siteName: "无限画布", description: "开源 AI 创作工作台", logoUrl: "", announcement: "", hidePrivateChannels: false, userCloudStorageEnabled: true, publicContent: {prompts:true,tutorials:true,skills:true,assets:true}, defaultStorageBytes: config.USER_STORAGE_BYTES, promptSyncMinutes: 30 };
}
export async function requireCloudStorage(db: Database, config: Config) {
    await db.query("SELECT id FROM canvas_site_settings WHERE id=true FOR SHARE");
    if (!(await readSettings(db, config)).userCloudStorageEnabled) throw Object.assign(new Error("管理员已关闭云端存储"), { statusCode: 403, code: "CLOUD_STORAGE_DISABLED" });
}
export async function storageQuota(db: Database, config: Config, userId: string) {
    const user = (await db.query("SELECT storage_bytes FROM canvas_users WHERE id=$1", [userId])).rows[0];
    return user?.storage_bytes == null ? (await readSettings(db,config)).defaultStorageBytes : Number(user.storage_bytes);
}
export async function storageUsage(db: Database, userId: string) {
    const row = (await db.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM canvas_media WHERE user_id=$1 AND (ready OR expires_at>now())) + (SELECT COALESCE(SUM(octet_length(data::text)),0) FROM canvas_records WHERE user_id=$1 AND NOT deleted) AS bytes",[userId])).rows[0];
    return Number(row.bytes);
}
export async function audit(db: Database, actor: string, action: string, target: string, summary: unknown = {}) {
    await db.query("INSERT INTO canvas_admin_audit(actor_id,action,target,summary) VALUES($1,$2,$3,$4)",[actor,action,target,JSON.stringify(summary)]);
}
export function libraryItem(row: Record<string, any>) {
    return { id:row.id, kind:row.kind, data:{...row.remote_data,...row.data}, published:row.published, position:Number(row.position), sourceId:row.source_id, remotePresent:row.remote_present, revision:Number(row.revision), createdAt:row.created_at, updatedAt:row.updated_at };
}
export const publicCondition = "l.deleted=false AND l.published AND l.remote_present AND (l.source_id IS NULL OR EXISTS(SELECT 1 FROM canvas_prompt_sources s WHERE s.id=l.source_id AND s.enabled AND NOT s.deleted))";
