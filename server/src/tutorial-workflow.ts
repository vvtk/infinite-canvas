import { z } from "zod";
import { workflowGraphError, workflowNodeTypes } from "../../shared/tutorial-workflow.js";

const number = z.number().finite();
const nonnegative = number.nonnegative();
const status = z.enum(["idle", "success"]);
const metadata = z.object({
    content: z.string().optional(), composerContent: z.string().optional(), prompt: z.string().optional(), status: status.optional(),
    fontSize: number.positive().optional(), generationMode: z.enum(["text", "image", "video", "audio"]).optional(), generationType: z.enum(["generation", "edit"]).optional(),
    reasoningEffort: z.enum(["auto", "low", "medium", "high", "xhigh"]).optional(),
    size: z.string().optional(), quality: z.string().optional(), background: z.string().optional(), count: number.int().positive().optional(), textCount: number.int().positive().optional(),
    texts: z.array(z.object({ id: z.string().min(1), status, content: z.string() }).strict()).optional(), primaryTextId: z.string().optional(),
    seconds: z.string().optional(), vquality: z.string().optional(), generateAudio: z.string().optional(), watermark: z.string().optional(), videoMode: z.string().optional(),
    audioVoice: z.string().optional(), audioFormat: z.string().optional(), audioSpeed: z.string().optional(), audioInstructions: z.string().optional(),
    references: z.array(z.string()).optional(), naturalWidth: nonnegative.optional(), naturalHeight: nonnegative.optional(), freeResize: z.boolean().optional(),
    images: z.array(z.object({ id: z.string().min(1), status, content: z.string(), storageKey: z.string().optional(), naturalWidth: nonnegative, naturalHeight: nonnegative, bytes: nonnegative, mimeType: z.string() }).strict()).optional(),
    primaryImageId: z.string().optional(), storageKey: z.string().optional(), mimeType: z.string().optional(), bytes: nonnegative.optional(), durationMs: nonnegative.optional(), groupId: z.string().optional(),
}).strict();

export const workflowSchema = z.object({
    version: z.literal(1),
    nodes: z.array(z.object({ id: z.string().min(1), type: z.enum(workflowNodeTypes), title: z.string(), position: z.object({ x: number, y: number }).strict(), width: number.positive(), height: number.positive(), metadata: metadata.optional() }).strict()),
    connections: z.array(z.object({ id: z.string().min(1), fromNodeId: z.string(), toNodeId: z.string() }).strict()),
    models: z.record(z.string(), z.object({ name: z.string().trim().min(1), capability: z.enum(["text", "image", "video", "audio"]) }).strict()),
    media: z.array(z.object({ mediaId: z.uuid(), mimeType: z.string().regex(/^(image|video|audio)\//), bytes: nonnegative.int().positive().safe(), sha256: z.string().regex(/^[a-f\d]{64}$/) }).strict()),
}).strict().superRefine((flow, context) => {
    const error = workflowGraphError(flow);
    if (error) context.addIssue({ code: "custom", message: error });
});

export function workflowSummary(data: Record<string, any>) {
    if (data.format !== "workflow") return data;
    const { workflow, ...summary } = data;
    return { ...summary, workflowSummary: { nodeCount: workflow?.nodes?.length || 0, connectionCount: workflow?.connections?.length || 0 } };
}
