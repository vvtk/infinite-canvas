import { nanoid } from "nanoid";
import { cloudRequest, CloudError } from "@/services/api/cloud";
import { applyRecord, hydrateMedia, captureRecords, cloudMeta, mediaBlob, mediaKeys, saveMediaBlob, waitForCloudData, type CloudRecord } from "@/services/cloud-data";
import { useCloudStore } from "@/stores/use-cloud-store";
import { useSiteStore } from "@/stores/use-site-store";
import { useUserStore } from "@/stores/use-user-store";

type Baseline = { revision: number; hash: string; domain: CloudRecord["domain"]; id: string };
const keyOf = (record: Pick<CloudRecord, "domain" | "id">) => `${record.domain}/${record.id}`;
// Canonicalize keys so reordered JSON and hydrated Blob URLs do not create edits.
export function recordHash(record: Pick<CloudRecord, "deleted" | "data">): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    return JSON.stringify([record.deleted, canonical(record.data)]);
}
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let stopped = true;
let syncController = new AbortController();
let syncingAccount = "";
let generation = 0;
let started = false;
const fail = (error: unknown, signal: AbortSignal) => {
    if (signal.aborted) return;
    if (error instanceof CloudError && (error.body as {code?:string})?.code === "CLOUD_STORAGE_DISABLED") {
        const site = useSiteStore.getState().settings;
        if (site) useSiteStore.setState({ settings: { ...site, userCloudStorageEnabled: false } });
        updateCloudSyncAvailability();
        return;
    }
    useCloudStore.setState({ status: "error", error: error instanceof Error ? error.message : "同步失败，本地数据已保留" });
};
function schedule() {
    if (stopped) return;
    generation++;
    useCloudStore.setState({ status: "pending" });
    clearTimeout(timer);
    timer = setTimeout(() => { void syncNow(); }, 2000);
}
export async function stopCloudSync() { stopped = true; clearTimeout(timer); syncController.abort(); await running; }
export function updateCloudSyncAvailability() {
    const settings = useSiteStore.getState().settings;
    const accountId = useUserStore.getState().user?.id || "";
    if (syncingAccount !== accountId) { stopped = true; syncController.abort(); syncingAccount = accountId; }
    const disabled = settings?.userCloudStorageEnabled === false;
    if (!accountId || !settings || disabled) {
        stopped = true; clearTimeout(timer); syncController.abort();
        useCloudStore.setState({ status: disabled ? "disabled" : "local", error: "" });
        return;
    }
    if (!stopped) return;
    stopped = false; syncController = new AbortController();
    void (running || Promise.resolve()).then(() => { if (!stopped) void syncNow(); });
}
export function startCloudSync() {
    if (!started) {
        started = true;
        window.addEventListener("canvas-local-save", schedule);
        window.addEventListener("online", () => { void syncNow(); });
        window.addEventListener("focus", () => { void syncNow(); });
    }
    updateCloudSyncAvailability();
}
async function uploadMedia(storageKey: string, signal: AbortSignal) {
    const cached = await cloudMeta.getItem<string>(`media:${storageKey}`);
    if (cached) return cached;
    const blob = await mediaBlob(storageKey);
    if (!blob) throw new Error("引用的原始媒体在本地缺失，暂未同步");
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const result = await cloudRequest<{ id: string; ready: boolean; upload?: { url: string; fields: Record<string, string> } }>("/media/uploads", { storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", sha256: checksum }, "POST", signal);
    if (!result.ready && result.upload) {
        const body = new FormData();
        Object.entries(result.upload.fields).forEach(([key, value]) => body.append(key, value));
        body.append("file", blob);
        const response = await fetch(result.upload.url, { method: "POST", body, signal });
        if (!response.ok) throw new Error("媒体上传失败，本地文件已保留");
        await cloudRequest(`/media/${result.id}/complete`, {}, "POST", signal);
    }
    signal.throwIfAborted();
    await cloudMeta.setItem(`media:${storageKey}`, result.id);
    return result.id;
}
async function ensureRemoteMedia(ids: string[], signal: AbortSignal) {
    for (const id of ids) {
        const remote = await cloudRequest<{ storageKey: string; mimeType: string; url: string }>(`/media/${id}/url`, undefined, "GET", signal);
        if (!(await mediaBlob(remote.storageKey))) {
            const response = await fetch(`/api/media/${encodeURIComponent(id)}/content`, { credentials: "same-origin", cache: "no-store", signal });
            if (!response.ok) throw new Error("原始媒体下载失败，请重试同步");
            const blob = await response.blob();
            signal.throwIfAborted();
            await saveMediaBlob(remote.storageKey, blob.type ? blob : blob.slice(0, blob.size, remote.mimeType));
        }
        await cloudMeta.setItem(`media:${remote.storageKey}`, id);
    }
}
async function preserveConflict(record: CloudRecord) {
    useCloudStore.setState((state) => ({ conflicts: state.conflicts + 1 }));
    if (record.deleted || !record.data) return;
    const id = nanoid();
    const data = { ...record.data, id, title: `${record.data.title || "记录"}（冲突副本）`, updatedAt: new Date().toISOString() };
    await applyRecord({ ...record, id, data, revision: 0 }, true);
}
export async function syncNow(): Promise<void> {
    if (stopped) return;
    if (running) return running;
    const signal = syncController.signal;
    running = runSync(signal).catch(error => fail(error, signal)).finally(() => { running = undefined; });
    return running;
}
async function runSync(signal: AbortSignal) {
    await waitForCloudData();
    if (stopped || signal.aborted) return;
    const startGeneration = generation;
    useCloudStore.setState({ status: "syncing", error: "" });
    const baselines = (await cloudMeta.getItem<Record<string, Baseline>>("records")) || {};
    const local = await captureRecords();
    const current = new Map(local.map((item) => [keyOf(item), item]));
    for (const [key, base] of Object.entries(baselines)) if (!current.has(key)) local.push({ domain: base.domain, id: base.id, revision: base.revision, deleted: true, data: null, media: [] });
    for (const record of local) {
        signal.throwIfAborted();
        const key = keyOf(record);
        const base = baselines[key];
        const hash = recordHash(record);
        if (base?.hash === hash) continue;
        const media: string[] = [];
        for (const storageKey of mediaKeys(record.data)) media.push(await uploadMedia(storageKey, signal));
        try {
            const result = await cloudRequest<{ revision: number }>("/sync/records", { ...record, media, baseRevision: base?.revision || 0 }, "POST", signal);
            baselines[key] = { domain: record.domain, id: record.id, revision: result.revision, hash };
            await cloudMeta.setItem("records", baselines);
        } catch (error) {
            if (!(error instanceof CloudError) || error.status !== 409) throw error;
            // Use the latest local value, including edits made during media upload.
            const remote = (error.body as { conflict: CloudRecord | null }).conflict;
            if (remote) {
                await ensureRemoteMedia(remote.media, signal);
                const prepared = { ...remote, data: await hydrateMedia(remote.data) as CloudRecord["data"] };
                const latest = (await captureRecords()).find((item) => keyOf(item) === key) || record;
                signal.throwIfAborted();
                await preserveConflict(latest);
                await applyRecord(prepared, true);
                baselines[key] = { domain: remote.domain, id: remote.id, revision: remote.revision, hash: recordHash(remote) };
                await cloudMeta.setItem("records", baselines);
            }
        }
    }
    const cursor = (await cloudMeta.getItem<number>("cursor")) || 0;
    const changes = await cloudRequest<{ cursor: number; records: CloudRecord[] }>(`/sync/changes?cursor=${cursor}`, undefined, "GET", signal);
    for (const remote of changes.records) {
        const key = keyOf(remote);
        const base = baselines[key];
        if (base?.revision === remote.revision) continue;
        await ensureRemoteMedia(remote.media, signal);
        const prepared = { ...remote, data: await hydrateMedia(remote.data) as CloudRecord["data"] };
        const latest = (await captureRecords()).find((item) => keyOf(item) === key);
        signal.throwIfAborted();
        if (latest && (!base || recordHash(latest) !== base.hash)) await preserveConflict(latest);
        await applyRecord(prepared, true);
        baselines[key] = { domain: remote.domain, id: remote.id, revision: remote.revision, hash: recordHash(remote) };
        await cloudMeta.setItem("records", baselines);
    }
    await cloudMeta.setItem("cursor", changes.cursor);
    signal.throwIfAborted();
    useCloudStore.setState({ status: generation === startGeneration ? "synced" : "pending" });
    if (generation !== startGeneration) { clearTimeout(timer); timer = setTimeout(() => { void syncNow(); }, 2000); }
}
