import { nanoid } from "nanoid";

import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasImageTarget = { nodeId: string; imageId: string };

export function applyImagePrimary(node: CanvasNodeData, imageId: string): CanvasNodeData {
    const image = node.metadata?.images?.find((item) => item.id === imageId);
    if (!image?.content) return node;
    const isPrimary = imageId === (node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id);
    const edge = Math.max(node.width, node.height);
    const size = node.metadata?.freeResize || isPrimary ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
    return {
        ...node,
        position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
        ...size,
        metadata: {
            ...node.metadata,
            content: image.content,
            storageKey: image.storageKey,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            bytes: image.bytes,
            mimeType: image.mimeType,
            primaryImageId: image.id,
        },
    };
}

export function getExpandedImageOffset(node: CanvasNodeData, index: number) {
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    return { x: (slot % columns) * (node.width + 18), y: (Math.floor(slot / columns) - rows + 1) * (node.height + 18) };
}

export function getCanvasImageNode(node: CanvasNodeData, imageId?: string, expanded = false): CanvasNodeData | null {
    const images = node.metadata?.images || [];
    const primaryId = node.metadata?.primaryImageId || images[0]?.id;
    const image = images.find((item) => item.id === (imageId || primaryId));
    if (imageId && !image?.content) return null;
    if (!image) return node.metadata?.content ? node : null;
    if (!image.content) return null;
    const { id, ...metadata } = image;
    const index = images.filter((item) => item.id !== primaryId).findIndex((item) => item.id === id);
    const offset = expanded && index >= 0 ? getExpandedImageOffset(node, index) : { x: 0, y: 0 };
    return {
        ...node,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        metadata: { ...node.metadata, ...metadata, images: undefined, primaryImageId: undefined, count: 1 },
    };
}

export function createCanvasImageCopy(node: CanvasNodeData): CanvasNodeData {
    const edge = Math.max(node.width, node.height);
    const size = fitNodeSize(node.metadata?.naturalWidth || node.width, node.metadata?.naturalHeight || node.height, edge, edge);
    return {
        id: nanoid(),
        type: CanvasNodeType.Image,
        title: node.title,
        position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
        ...size,
        metadata: {
            content: node.metadata?.content,
            storageKey: node.metadata?.storageKey,
            naturalWidth: node.metadata?.naturalWidth,
            naturalHeight: node.metadata?.naturalHeight,
            bytes: node.metadata?.bytes,
            mimeType: node.metadata?.mimeType,
            status: "success",
            prompt: node.metadata?.prompt,
            generationType: node.metadata?.generationType,
            model: node.metadata?.model,
            size: node.metadata?.size,
            quality: node.metadata?.quality,
            background: node.metadata?.background,
            references: node.metadata?.references,
        },
    };
}
