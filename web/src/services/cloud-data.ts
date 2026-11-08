import { accountStorage } from "@/lib/account-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { getImageBlob, setImageBlob, resolveImageUrl } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob, resolveMediaUrl } from "@/services/file-storage";

export type CloudDomain = "canvas" | "assets" | "image-workbench" | "video-workbench";
export type CloudRecord = { domain: CloudDomain; id: string; revision: number; deleted: boolean; data: Record<string, unknown> | null; media: string[] };
const imageLogs = accountStorage({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogs = accountStorage({ name: "infinite-canvas", storeName: "video_generation_logs" });
export const cloudMeta = accountStorage({ name: "infinite-canvas", storeName: "cloud_meta" });
export const mediaBlob = (key: string) => key.startsWith("image:") ? getImageBlob(key) : getMediaBlob(key);
export const saveMediaBlob = (key: string, blob: Blob) => key.startsWith("image:") ? setImageBlob(key, blob) : setMediaBlob(key, blob);
export function cleanCloudData(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cleanCloudData);
    if (!value || typeof value !== "object") return typeof value === "string" && value.startsWith("blob:") ? "" : value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api.?key|access.?token|refresh.?token|password|authorization|preview|previewUrl|thumbnail)$/i.test(key)).map(([key, child]) => [key, cleanCloudData(child)]));
}
export function mediaKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    for (const [key, child] of Object.entries(value)) {
        if (key === "storageKey" && typeof child === "string" && /^(image|video|audio|file|video-reference|audio-reference):/.test(child)) keys.add(child);
        else mediaKeys(child, keys);
    }
    return keys;
}
export async function captureRecords(): Promise<CloudRecord[]> {
    const result: CloudRecord[] = [];
    const add = (domain: CloudDomain, id: string, data: unknown, deleted = false) => result.push({ domain, id, data: cleanCloudData(data) as CloudRecord["data"], deleted, revision: 0, media: [] });
    const canvas = useCanvasStore.getState();
    for (const item of canvas.projects) add("canvas", item.id, item);
    for (const item of canvas.deletedProjects) if (!canvas.projects.some((project) => project.id === item.id)) add("canvas", item.id, null, true);
    for (const item of useAssetStore.getState().assets) add("assets", item.id, item);
    for (const [domain, store] of [["image-workbench", imageLogs], ["video-workbench", videoLogs]] as const) {
        await store.iterate<Record<string, unknown>, void>((item, id) => { add(domain, id, item); });
    }
    return result;
}
export async function waitForCloudData() {
    await Promise.all([useCanvasStore, useAssetStore].map(async (store) => {
        if (store.getState().hydrated) return;
        await new Promise<void>((resolve) => { const unsubscribe = store.subscribe((state) => { if (state.hydrated) { unsubscribe(); resolve(); } }); });
    }));
}
export async function hydrateMedia(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(hydrateMedia));
    if (!value || typeof value !== "object") return value;
    const input = value as Record<string, unknown>;
    const output = Object.fromEntries(await Promise.all(Object.entries(input).map(async ([key, child]) => [key, await hydrateMedia(child)])));
    if (typeof input.storageKey === "string") {
        const url = await (input.storageKey.startsWith("image:") ? resolveImageUrl(input.storageKey) : resolveMediaUrl(input.storageKey));
        if (url) for (const field of ["url", "dataUrl", "imageUrl", "coverUrl", "content"]) if (field in output && !output[field]) output[field] = url;
    }
    return output;
}
export async function applyRecord(record: CloudRecord, prepared = false) {
    const data = prepared ? record.data : await hydrateMedia(record.data);
    if (record.domain === "canvas") {
        const state = useCanvasStore.getState();
        state.replaceProjects([...state.projects.filter((item) => item.id !== record.id), ...(record.deleted ? [] : [data as CanvasProject])], [...state.deletedProjects.filter((item) => item.id !== record.id), ...(record.deleted ? [{ id: record.id, deletedAt: new Date().toISOString() }] : [])]);
    } else if (record.domain === "assets") {
        const state = useAssetStore.getState();
        state.replaceAssets([...state.assets.filter((item) => item.id !== record.id), ...(record.deleted ? [] : [data as Asset])]);
    } else {
        const store = record.domain === "image-workbench" ? imageLogs : videoLogs;
        if (record.deleted) await store.removeItem(record.id); else await store.setItem(record.id, data);
    }
    window.dispatchEvent(new CustomEvent("canvas-cloud-applied", { detail: record }));
}
