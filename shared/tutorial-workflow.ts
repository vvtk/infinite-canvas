export const workflowNodeTypes = ["text", "image", "video", "audio", "config", "group"] as const;
export type WorkflowCapability = "text" | "image" | "video" | "audio";
export type WorkflowMedia = { mediaId: string; mimeType: string; bytes: number; sha256: string };
export type WorkflowMetadata = {
    content?: string; composerContent?: string; prompt?: string;
    status?: "idle" | "success";
    fontSize?: number; generationMode?: WorkflowCapability; generationType?: "generation" | "edit";
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string; quality?: string; background?: string; count?: number; textCount?: number;
    texts?: { id: string; status: "idle" | "success"; content: string }[]; primaryTextId?: string;
    seconds?: string; vquality?: string; generateAudio?: string; watermark?: string; videoMode?: string;
    audioVoice?: string; audioFormat?: string; audioSpeed?: string; audioInstructions?: string;
    references?: string[]; naturalWidth?: number; naturalHeight?: number; freeResize?: boolean;
    images?: { id: string; status: "idle" | "success"; content: string; storageKey?: string; naturalWidth: number; naturalHeight: number; bytes: number; mimeType: string }[];
    primaryImageId?: string; storageKey?: string; mimeType?: string; bytes?: number; durationMs?: number; groupId?: string;
};
export type WorkflowNode = {
    id: string; type: typeof workflowNodeTypes[number]; title: string;
    position: { x: number; y: number }; width: number; height: number; metadata?: WorkflowMetadata;
};
export type WorkflowDocument = {
    version: 1;
    nodes: WorkflowNode[];
    connections: { id: string; fromNodeId: string; toNodeId: string }[];
    models: Record<string, { name: string; capability: WorkflowCapability }>;
    media: WorkflowMedia[];
};
export const workflowMediaUrl = (id: string) => `/api/library/media/${encodeURIComponent(id)}`;
export const workflowMediaKey = (id: string) => `workflow:${id}`;

export function workflowGraphError(flow: WorkflowDocument): string | undefined {
    try { return validateWorkflowGraph(flow); }
    catch { return "流程结构损坏，请重新保存教程"; }
}

function validateWorkflowGraph(flow: WorkflowDocument): string | undefined {
    if (!flow || flow.version !== 1 || !Array.isArray(flow.nodes) || !Array.isArray(flow.connections) || !Array.isArray(flow.media) || !flow.models || typeof flow.models !== "object" || Array.isArray(flow.models)) return "不支持的流程格式";
    if (flow.nodes.some(node => !node || typeof node.id !== "string" || typeof node.title !== "string" || (node.metadata && typeof node.metadata !== "object"))) return "流程节点格式无效";
    if (flow.nodes.some(node => !workflowNodeTypes.includes(node.type))) return "流程包含不支持的插件或未知节点";
    if (flow.nodes.some(node => !node.id || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0 || node.height <= 0)) return "流程节点的 ID、位置或尺寸无效";
    const nodes = new Map(flow.nodes.map(node => [node.id, node]));
    if (!nodes.size) return "请至少添加一个流程节点";
    if (nodes.size !== flow.nodes.length) return "流程节点 ID 重复";
    if (flow.connections.some(edge => !edge || typeof edge.id !== "string" || !edge.id)) return "流程连线格式无效";
    if (new Set(flow.connections.map(edge => edge.id)).size !== flow.connections.length) return "流程连线 ID 重复";
    if (flow.connections.some(edge => !nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId))) return "流程连线引用了不存在的节点";
    for (const node of flow.nodes) {
        const visited = new Set([node.id]);
        let groupId = node.metadata?.groupId;
        while (groupId) {
            if (visited.has(groupId) || nodes.get(groupId)?.type !== "group") return "流程分组引用无效或存在循环";
            visited.add(groupId);
            groupId = nodes.get(groupId)?.metadata?.groupId;
        }
        for (const [items, primary] of [[node.metadata?.images, node.metadata?.primaryImageId], [node.metadata?.texts, node.metadata?.primaryTextId]] as const) {
            if (items && (!Array.isArray(items) || items.some(item => !item || typeof item.id !== "string" || !item.id))) return "流程节点子项格式无效";
            if (items && new Set(items.map(item => item.id)).size !== items.length) return "流程节点内的子项 ID 重复";
            if (primary && !items?.some(item => item.id === primary)) return "流程节点的主内容引用无效";
        }
        for (const content of [node.metadata?.composerContent, node.metadata?.prompt]) {
            if (content !== undefined && typeof content !== "string") return "流程提示词格式无效";
            for (const match of (content || "").matchAll(/@\[node:([^\]]+)\]/g)) if (!nodes.has(match[1])) return "流程提示词引用了不存在的节点";
        }
    }
    for (const [id, binding] of Object.entries(flow.models)) {
        const node = nodes.get(id);
        if (!node) return "模型绑定引用了不存在的节点";
        if (typeof binding?.name !== "string" || !binding.name.trim() || !["text", "image", "video", "audio"].includes(binding.capability) || node.type === "group") return "流程模型名称或能力无效";
        const capability = node.metadata?.generationMode || (node.type === "config" ? "image" : node.type);
        if (binding.capability !== capability) return "流程模型能力与节点生成类型不匹配";
    }
    if (flow.media.some(item => !item)) return "流程媒体清单无效";
    if (new Set(flow.media.map(item => item.mediaId)).size !== flow.media.length) return "流程媒体 ID 重复";
    if (flow.media.some(item => typeof item.mediaId !== "string" || !item.mediaId || !/^(image|video|audio)\//.test(item.mimeType) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f\d]{64}$/.test(item.sha256))) return "流程媒体清单无效";
    const byUrl = new Map(flow.media.map(item => [workflowMediaUrl(item.mediaId), item]));
    const used = new Set<string>();
    const mediaError = (content?: string, key?: string, kind?: string, mimeType?: string, bytes?: number) => {
        if (!content && !key) return;
        const item = byUrl.get(content || "");
        if (!item || (key && key !== workflowMediaKey(item.mediaId)) || (kind && !item.mimeType.startsWith(`${kind}/`)) || (mimeType && mimeType !== item.mimeType) || (bytes !== undefined && bytes !== item.bytes)) return "流程素材必须引用清单中匹配的公共媒体";
        used.add(item.mediaId);
    };
    for (const node of flow.nodes) {
        const value = node.metadata;
        if (!value) continue;
        if (["image", "video", "audio"].includes(node.type)) {
            const error = mediaError(value.content, value.storageKey, node.type, value.mimeType, value.bytes);
            if (error) return error;
        } else if (value.storageKey) return "非媒体节点不能保存媒体存储键";
        for (const image of value.images || []) { const error = mediaError(image.content, image.storageKey, "image", image.mimeType, image.bytes); if (error) return error; }
        for (const url of value.references || []) { const error = mediaError(url); if (error) return error; }
    }
    if (flow.media.some(item => !used.has(item.mediaId))) return "流程媒体清单包含未使用的素材";
}
