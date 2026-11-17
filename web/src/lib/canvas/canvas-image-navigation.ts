import type { CanvasNodeImage } from "@/types/canvas";

export function getAdjacentImageId(images: CanvasNodeImage[], currentId: string | undefined, direction: -1 | 1) {
    const viewable = images.filter((image) => image.content);
    if (viewable.length < 2) return null;
    const index = viewable.findIndex((image) => image.id === currentId);
    const next = index < 0 ? (direction === 1 ? 0 : viewable.length - 1) : (index + direction + viewable.length) % viewable.length;
    return viewable[next].id;
}
