import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { emptySystemChannel, systemModelKeys } from "../../shared/system-channel.js";
import { transaction } from "./db.js";
import { audit, fail } from "./management.js";
import type { Session } from "./auth.js";

const numeric = z.string().refine(value => value.trim() !== "" && Number.isFinite(Number(value)));
export const systemPreferencesSchema = z.object({
    imageModel: z.string(), videoModel: z.string(), textModel: z.string(), audioModel: z.string(),
    quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]), size: z.string().trim().min(1), background: z.string(),
    count: numeric.refine(value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 15),
    canvasImageCount: numeric.refine(value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 15),
    videoSeconds: numeric.refine(value => Number(value) >= 4 && Number(value) <= 30), vquality: z.string().trim().min(1),
    videoGenerateAudio: z.enum(["true", "false"]), videoWatermark: z.enum(["true", "false"]), videoMode: z.enum(["frames", "reference"]),
    audioVoice: z.string().trim().min(1), audioFormat: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]),
    audioSpeed: numeric.refine(value => Number(value) >= 0.25 && Number(value) <= 4), audioInstructions: z.string(),
    reasoningEffort: z.enum(["auto", "low", "medium", "high", "xhigh"]), nodeRegenerateBehavior: z.enum(["new-node", "overwrite"]),
    streamText: z.boolean(), returnBase64: z.boolean(), imageSystemPrompt: z.string(), videoSystemPrompt: z.string(), textSystemPrompt: z.string(),
}).strict();
export const systemChannelSchema = z.object({
    models: z.array(z.object({ name: z.string().trim().min(1), capability: z.enum(["image", "video", "text", "audio"]), script: z.string().optional() }).strict()),
    enabledModels: z.array(z.string().trim().min(1)), defaults: systemPreferencesSchema,
}).strict().superRefine((data, ctx) => {
    const names = new Set(data.models.map(model => model.name));
    if (names.size !== data.models.length || new Set(data.enabledModels).size !== data.enabledModels.length || data.enabledModels.some(name => !names.has(name))) ctx.addIssue({ code: "custom", message: "模型不能重复，开放模型必须存在于目录中" });
    for (const key of systemModelKeys) if (data.defaults[key] && !data.models.some(model => model.name === data.defaults[key] && data.enabledModels.includes(model.name) && key === `${model.capability}Model`)) ctx.addIssue({ code: "custom", path: ["defaults", key], message: "默认模型必须已开放且能力匹配" });
});

export async function systemChannelRoutes(app: FastifyInstance, pool: Pool, requireSuperAdmin: (request: FastifyRequest) => Promise<Session>, requireSession: (request: FastifyRequest) => Promise<Session>) {
    await pool.query("INSERT INTO canvas_system_channel(id,data) VALUES(true,$1) ON CONFLICT DO NOTHING", [JSON.stringify(emptySystemChannel)]);
    const read = async () => {
        const row = (await pool.query("SELECT data,revision FROM canvas_system_channel WHERE id=true")).rows[0];
        return { data: systemChannelSchema.parse(row.data), revision: Number(row.revision) };
    };
    app.get("/api/admin/system-channel", async request => { await requireSuperAdmin(request); return read(); });
    app.patch("/api/admin/system-channel", async request => {
        const actor = await requireSuperAdmin(request);
        const { data, revision } = z.object({ data: systemChannelSchema, revision: z.number().int().positive() }).strict().parse(request.body);
        await transaction(pool, async db => {
            if (!(await db.query("UPDATE canvas_system_channel SET data=$1,revision=revision+1 WHERE id=true AND revision=$2", [JSON.stringify(data), revision])).rowCount) fail(409, "系统渠道已被修改，请刷新后重试");
            await audit(db, actor.userId, "system-channel.update", "system-channel", { models: data.models.map(({ name, capability }) => ({ name, capability })), enabledModels: data.enabledModels });
        });
        return { success: true };
    });
    app.get("/api/system-channel", async request => {
        await requireSession(request);
        const { data, revision } = await read();
        return { data: { ...data, models: data.models.filter(model => data.enabledModels.includes(model.name)) }, revision };
    });
}
