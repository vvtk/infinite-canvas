import { nanoid } from "nanoid";
import { workflowGraphError, workflowMediaKey, workflowMediaUrl, type WorkflowDocument } from "../../../../shared/tutorial-workflow";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

export const WORKFLOW_DRAG_TYPE = "application/x-infinite-canvas-workflow";
export type WorkflowLocalMedia = { storageKey: string; url: string };

export function resetWorkflowDraftNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes.map((node): CanvasNodeData => {
        if (!node.metadata) return node;
        const { errorDetails: _error, videoTaskId: _task, videoTaskReport: _report, videoTaskProvider: _provider, ...value } = node.metadata;
        return { ...node, metadata: { ...value, status: value.content ? "success" : "idle", images: value.images?.map(({ errorDetails: _error, ...image }) => ({ ...image, status: image.content ? "success" : "idle" })), texts: value.texts?.map(({ errorDetails: _error, ...text }) => ({ ...text, status: text.content ? "success" : "idle" })) } };
    });
}

export function instantiateWorkflow(flow: WorkflowDocument, media: Map<string, WorkflowLocalMedia>, model: (binding: WorkflowDocument["models"][string]) => string, center: Position, newId = nanoid): { nodes: CanvasNodeData[]; connections: CanvasConnection[] } {
    const error = workflowGraphError(flow);
    if (error) throw new Error(error);
    const ids = new Map(flow.nodes.map(node => [node.id, newId()]));
    const bounds = flow.nodes.reduce((box, node) => ({ left: Math.min(box.left, node.position.x), top: Math.min(box.top, node.position.y), right: Math.max(box.right, node.position.x + node.width), bottom: Math.max(box.bottom, node.position.y + node.height) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const dx = center.x - (bounds.left + bounds.right) / 2;
    const dy = center.y - (bounds.top + bounds.bottom) / 2;
    const local = (url: string) => {
        const item = media.get(url);
        if (!item) throw new Error("流程素材尚未准备完成");
        return item;
    };
    const nodes: CanvasNodeData[] = flow.nodes.map(source => {
        const node: CanvasNodeData = structuredClone(source);
        node.id = ids.get(source.id)!;
        node.position = { x: node.position.x + dx, y: node.position.y + dy };
        const value = node.metadata;
        if (value) {
            if (value.groupId) value.groupId = ids.get(value.groupId);
            for (const key of ["composerContent", "prompt"] as const) {
                value[key] = value[key]?.replace(/@\[node:([^\]]+)\]/g, (token, id: string) => ids.has(id) ? `@[node:${ids.get(id)}]` : token);
            }
            if (["image", "video", "audio"].includes(node.type) && value.content) {
                const item = local(value.content);
                value.content = item.url;
                value.storageKey = item.storageKey;
            }
            const imageIds = new Map(value.images?.map(image => [image.id, newId()]));
            value.images = value.images?.map(image => ({ ...image, id: imageIds.get(image.id)!, ...(image.content ? { content: local(image.content).url, storageKey: local(image.content).storageKey } : {}) }));
            if (value.primaryImageId) value.primaryImageId = imageIds.get(value.primaryImageId);
            const textIds = new Map(value.texts?.map(text => [text.id, newId()]));
            value.texts = value.texts?.map(text => ({ ...text, id: textIds.get(text.id)! }));
            if (value.primaryTextId) value.primaryTextId = textIds.get(value.primaryTextId);
            value.references = value.references?.map(url => local(url).storageKey);
        }
        if (flow.models[source.id]) node.metadata = { ...value, model: model(flow.models[source.id]) };
        return node;
    });
    return { nodes, connections: flow.connections.map(edge => ({ id: newId(), fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! })) };
}

export function workflowMediaMap(flow: WorkflowDocument, values: WorkflowLocalMedia[]) {
    return new Map(flow.media.flatMap((item, index) => [[workflowMediaUrl(item.mediaId), values[index]], [workflowMediaKey(item.mediaId), values[index]]] as [string, WorkflowLocalMedia][]));
}
