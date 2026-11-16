import { nanoid } from "nanoid";
import { workflowGraphError, workflowMediaKey, workflowMediaUrl, workflowNodeTypes, type WorkflowDocument, type WorkflowMedia, type WorkflowMetadata, type WorkflowNode } from "../../../../shared/tutorial-workflow";
import { instantiateWorkflow, workflowMediaMap, type WorkflowLocalMedia } from "@/lib/canvas/tutorial-workflow";
import { decodeChannelModel, encodeChannelModel, modelCapabilityOf, modelOptionName, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import { getImageBlob, setImageBlob, deleteStoredImages } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob, deleteStoredMedia } from "@/services/file-storage";
import { retainWorkflowMedia } from "@/services/workflow-drafts";
import { fetchLibraryItem, uploadPublicFile } from "./admin";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

const metadataKeys = ["content", "composerContent", "prompt", "fontSize", "generationMode", "generationType", "reasoningEffort", "size", "quality", "background", "count", "textCount", "primaryTextId", "seconds", "vquality", "generateAudio", "watermark", "videoMode", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "naturalWidth", "naturalHeight", "freeResize", "primaryImageId", "mimeType", "bytes", "durationMs", "groupId"] as const;
const digest = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");

export function resolveWorkflowModel(config: AiConfig, binding: WorkflowDocument["models"][string]) {
    const matches = selectableModelsByCapability(config, binding.capability).filter(value => modelOptionName(value) === binding.name);
    return matches.length === 1 ? matches[0] : encodeChannelModel("workflow-unresolved", binding.name);
}

export async function publishWorkflow(nodes: CanvasNodeData[], connections: CanvasConnection[], config: AiConfig, existing: WorkflowMedia[], signal: AbortSignal): Promise<WorkflowDocument> {
    const flow: WorkflowDocument = { version: 1, nodes: [], connections: structuredClone(connections), models: {}, media: [] };
    const known = new Map(existing.map(item => [item.sha256, item]));
    const uploaded = new Map<string, WorkflowMedia>();
    const media = async (content?: string, storageKey?: string): Promise<WorkflowMedia | undefined> => {
        if (content && /^(image|video|audio|file|video-reference|audio-reference):/.test(content)) { storageKey = content; content = undefined; }
        if (!content && !storageKey) return;
        signal.throwIfAborted();
        const source = storageKey || content!;
        if (uploaded.has(source)) return uploaded.get(source)!;
        let blob = storageKey ? await (storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey)) : null;
        if (!blob && content) {
            const response = await fetch(content, { signal });
            if (!response.ok) throw new Error("流程素材读取失败，请重新上传素材");
            blob = await response.blob();
        }
        if (!blob || !/^(image|video|audio)\//.test(blob.type)) throw new Error("流程素材缺失或类型无效，请重新上传素材");
        const sha256 = await digest(blob);
        signal.throwIfAborted();
        let item = known.get(sha256);
        if (!item || item.mimeType !== blob.type || item.bytes !== blob.size) {
            const result = await uploadPublicFile(new File([blob], "workflow-media", { type: blob.type }), signal);
            item = { mediaId: result.id, mimeType: result.mimeType, bytes: result.bytes, sha256: result.sha256 };
            known.set(sha256, item);
        }
        uploaded.set(source, item);
        if (!flow.media.some(value => value.mediaId === item.mediaId)) flow.media.push(item);
        return item;
    };
    for (const source of nodes) {
        if (!(workflowNodeTypes as readonly string[]).includes(source.type)) throw new Error(`暂不支持插件节点：${source.title}`);
        const raw = source.metadata || {};
        const value: WorkflowMetadata = Object.fromEntries(metadataKeys.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
        value.status = raw.content ? "success" : "idle";
        if (raw.model) flow.models[source.id] = { name: decodeChannelModel(raw.model)?.model || raw.model, capability: modelCapabilityOf(config, raw.model) || raw.generationMode || (["image", "video", "audio"].includes(source.type) ? source.type as "image" | "video" | "audio" : source.type === "config" ? "image" : "text") };
        if (["image", "video", "audio"].includes(source.type)) {
            const item = await media(raw.content, raw.storageKey);
            if (item) { value.content = workflowMediaUrl(item.mediaId); value.storageKey = workflowMediaKey(item.mediaId); value.mimeType = item.mimeType; value.bytes = item.bytes; value.status = "success"; }
        }
        if (raw.images) {
            value.images = [];
            for (const image of raw.images) {
                const item = await media(image.content, image.storageKey);
                value.images.push({ id: image.id, status: item ? "success" : "idle", content: item ? workflowMediaUrl(item.mediaId) : "", ...(item ? { storageKey: workflowMediaKey(item.mediaId) } : {}), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, bytes: item?.bytes || 0, mimeType: item?.mimeType || "" });
            }
        }
        value.texts = raw.texts?.map(text => ({ id: text.id, content: text.content, status: text.content ? "success" : "idle" }));
        if (raw.references) {
            value.references = [];
            for (const url of raw.references) { const item = await media(url); if (item) value.references.push(workflowMediaUrl(item.mediaId)); }
        }
        flow.nodes.push({ id: source.id, type: source.type as WorkflowNode["type"], title: source.title, position: { ...source.position }, width: source.width, height: source.height, metadata: value });
    }
    const error = workflowGraphError(flow);
    if (error) throw new Error(error);
    return flow;
}

export async function materializeWorkflow(flow: WorkflowDocument, config: AiConfig, center: Position, signal: AbortSignal) {
    const error = workflowGraphError(flow);
    if (error) throw new Error(error);
    const values: WorkflowLocalMedia[] = [];
    const release = retainWorkflowMedia(values);
    const discard = async () => {
        await Promise.allSettled([deleteStoredImages(values.filter(item => item.storageKey.startsWith("image:")).map(item => item.storageKey)), deleteStoredMedia(values.filter(item => !item.storageKey.startsWith("image:")).map(item => item.storageKey))]);
        release();
    };
    try {
        for (const item of flow.media) {
            signal.throwIfAborted();
            const response = await fetch(workflowMediaUrl(item.mediaId), { signal, cache: "no-store" });
            if (!response.ok) throw new Error("流程媒体已下架或下载失败");
            const blob = await response.blob();
            if (blob.size !== item.bytes || (blob.type && blob.type !== item.mimeType) || await digest(blob) !== item.sha256) throw new Error("流程媒体校验失败，请重新加载教程");
            signal.throwIfAborted();
            const storageKey = `${item.mimeType.split("/")[0]}:${nanoid()}`;
            const target = { storageKey, url: "" };
            values.push(target);
            target.url = await (item.mimeType.startsWith("image/") ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob));
        }
        signal.throwIfAborted();
        const result = instantiateWorkflow(flow, workflowMediaMap(flow, values), binding => resolveWorkflowModel(config, binding), center);
        return { ...result, release, discard };
    } catch (error) { await discard(); throw error; }
}

export async function loadPublicWorkflow(id: string, config: AiConfig, center: Position, signal: AbortSignal) {
    const item = await fetchLibraryItem("tutorials", id, signal);
    if (item.data.format !== "workflow" || !item.data.workflow) throw new Error("教程不是节点流程或已下架");
    return materializeWorkflow(item.data.workflow, config, center, signal);
}
