import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { instantiateWorkflow, resetWorkflowDraftNodes, workflowMediaMap } from "../src/lib/canvas/tutorial-workflow";
import { workflowMediaUrl, type WorkflowDocument } from "../../shared/tutorial-workflow";
import type { CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const configStore = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const imageStorage = await import("../src/services/image-storage");
const fileStorage = await import("../src/services/file-storage");
const adminApi = await import("../src/services/api/admin");
const { loadPublicWorkflow, materializeWorkflow, publishWorkflow, resolveWorkflowModel } = await import("../src/services/api/tutorial-workflow");
const { emptyWorkflowDraft, isWorkflowMediaRetained, mergeSavedWorkflowDraft, retainWorkflowMedia, workflowDrafts, workflowDraftWriter, workflowMediaRetention } = await import("../src/services/workflow-drafts");
const { defaultConfig, useConfigStore } = configStore;
const originalConfig = useConfigStore.getState();
const originalFetch = globalThis.fetch;
const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).forEach(restore => restore()); globalThis.fetch = originalFetch; useConfigStore.setState(originalConfig); });
afterAll(() => { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });

function flow(): WorkflowDocument {
    return { version: 1, nodes: [
        { id: "group", type: "group", title: "分组", position: { x: -40, y: -20 }, width: 400, height: 240 },
        { id: "text", type: "text", title: "文本", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content: "原文", groupId: "group", texts: [{ id: "text-item", status: "success", content: "原文" }], primaryTextId: "text-item" } },
        { id: "config", type: "config", title: "配置", position: { x: 180, y: 40 }, width: 120, height: 100, metadata: { groupId: "group", prompt: "@[node:text]", composerContent: "@[node:text]", size: "16:9", count: 2 } },
    ], connections: [{ id: "edge", fromNodeId: "text", toNodeId: "config" }], models: { config: { name: "model-a", capability: "image" } }, media: [] };
}
const sha256 = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
async function audioFlow(count = 1) {
    const value = flow(), blob = new Blob(["fixture"], { type: "audio/mpeg" });
    for (let index = 0; index < count; index++) {
        const mediaId = `c8514b13-ad4a-4c7e-a356-ea3cd0f3bd0${index}`;
        value.media.push({ mediaId, mimeType: blob.type, bytes: blob.size, sha256: await sha256(blob) });
        value.nodes.push({ id: `audio-${index}`, type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content: workflowMediaUrl(mediaId), storageKey: `workflow:${mediaId}`, mimeType: blob.type, bytes: blob.size, references: [workflowMediaUrl(mediaId)] } });
    }
    return { value, blob };
}

test("inserting preserves layout and parameters while remapping every node, edge, group, child and prompt reference", () => {
    const source = flow(), original = structuredClone(source);
    let sequence = 0;
    const result = instantiateWorkflow(source, new Map(), () => "channel::model-a", { x: 1000, y: 500 }, () => `copy-${++sequence}`);
    const [group, text, config] = result.nodes;
    expect(group.position).toEqual({ x: 800, y: 380 });
    expect(config.position.x - text.position.x).toBe(180);
    expect(config.position.y - text.position.y).toBe(40);
    expect(text.metadata?.groupId).toBe(group.id);
    expect(config.metadata?.groupId).toBe(group.id);
    expect(text.metadata?.primaryTextId).toBe(text.metadata?.texts?.[0].id);
    expect(text.metadata?.primaryTextId).not.toBe("text-item");
    expect(config.metadata?.composerContent).toBe(`@[node:${text.id}]`);
    expect(config.metadata?.prompt).toBe(`@[node:${text.id}]`);
    expect(config.metadata?.model).toBe("channel::model-a");
    expect(config.metadata?.size).toBe("16:9");
    expect(result.connections).toEqual([{ id: `copy-${sequence}`, fromNodeId: text.id, toNodeId: config.id }]);
    config.metadata!.prompt = "独立修改";
    expect(source).toEqual(original);
    const second = instantiateWorkflow(source, new Map(), () => "channel::model-a", { x: -200, y: 0 }, () => `copy-${++sequence}`);
    expect(second.nodes.some(node => result.nodes.some(first => first.id === node.id))).toBe(false);
    expect(second.connections[0].id).not.toBe(result.connections[0].id);
    expect(text.metadata?.model).toBeUndefined();
    expect(buildGenerationConfig(defaultConfig, text, "text").model).toBe(defaultConfig.textModel);
});

test("image primary items and reference-only audio are mapped to new local keys without mutating the template", async () => {
    const { value, blob } = await audioFlow();
    const imageId = "01153385-185d-4e19-a2e2-489e4eb80da3", url = workflowMediaUrl(imageId);
    value.media.push({ mediaId: imageId, mimeType: "image/png", bytes: 4, sha256: "a".repeat(64) });
    value.nodes.push({ id: "image", type: "image", title: "图", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: url, storageKey: `workflow:${imageId}`, images: [{ id: "image-item", status: "success", content: url, storageKey: `workflow:${imageId}`, naturalWidth: 200, naturalHeight: 100, bytes: 4, mimeType: "image/png" }], primaryImageId: "image-item" } });
    const result = instantiateWorkflow(value, workflowMediaMap(value, [{ storageKey: "audio:copy", url: "blob:audio" }, { storageKey: "image:copy", url: "blob:image" }]), () => "channel::model-a", { x: 0, y: 0 });
    const image = result.nodes.at(-1)!;
    expect(image.metadata?.primaryImageId).toBe(image.metadata?.images?.[0].id);
    expect(image.metadata?.primaryImageId).not.toBe("image-item");
    expect(image.metadata?.content).toBe("blob:image");
    expect(image.metadata?.storageKey).toBe("image:copy");
    expect(result.nodes.find(node => node.type === "audio")?.metadata?.references).toEqual(["audio:copy"]);
    expect(fileStorage.collectMediaStorageKeys({ references: ["audio:copy"] }).has("audio:copy")).toBe(true);
    expect(imageStorage.collectImageStorageKeys({ references: ["image:copy"] }).has("image:copy")).toBe(true);
    expect(blob.type).toBe("audio/mpeg");
});

test("missing and ambiguous model names remain unresolved and block AI requests", () => {
    const channel = { id: "one", name: "One", baseUrl: "https://example.com", apiKey: "secret", apiFormat: "openai" as const, models: [{ name: "model-a", capability: "image" as const }, { name: "model-a", capability: "text" as const }] };
    const config = { ...defaultConfig, channels: [channel], models: ["one::model-a"] };
    useConfigStore.setState({ systemSnapshot: null, systemCatalog: [] });
    expect(resolveWorkflowModel(config, { name: "model-a", capability: "image" })).toBe("one::model-a");
    for (const input of [config, { ...config, channels: [channel, { ...channel, id: "two" }] }]) {
        const name = input === config ? "missing" : "model-a";
        const unresolved = resolveWorkflowModel(input, { name, capability: "image" });
        expect(unresolved).toBe(`workflow-unresolved::${name}`);
        expect(configStore.modelOptionLabel(input, unresolved)).toContain("待选择渠道");
        const selected = buildGenerationConfig(input, { ...flow().nodes[2], metadata: { model: unresolved } }, "image");
        expect(selected.model).toBe(unresolved);
        expect(useConfigStore.getState().isAiConfigReady(selected, selected.model)).toBe(false);
        expect(() => configStore.resolveModelRequestConfig(selected, selected.model)).toThrow();
    }
});

test("draft recovery clears tasks, loading and errors while retaining content and selected models", () => {
    const nodes: CanvasNodeData[] = [{ id: "v", type: "video", title: "视频", width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { status: "loading", model: "channel::video", videoTaskId: "old-task", videoTaskProvider: "openai", errorDetails: "old-error", content: "blob:example" } }];
    const recovered = resetWorkflowDraftNodes(nodes);
    expect(recovered[0].metadata?.status).toBe("success");
    expect(recovered[0].metadata?.content).toBe("blob:example");
    expect(recovered[0].metadata?.model).toBe("channel::video");
    for (const key of ["videoTaskId", "videoTaskProvider", "videoTaskReport", "errorDetails"]) expect(recovered[0].metadata).not.toHaveProperty(key);
    expect(nodes[0].metadata?.videoTaskId).toBe("old-task");
});

test("public insertion refetches details, copies all media independently and never calls AI", async () => {
    const { value, blob } = await audioFlow(), calls: string[] = [], keys: string[] = [];
    const save = spyOn(fileStorage, "setMediaBlob").mockImplementation(async key => { keys.push(key); return `blob:${key}`; }); restores.push(() => save.mockRestore());
    globalThis.fetch = (async (url: unknown) => {
        calls.push(String(url));
        return String(url).startsWith("/api/library/tutorials/") ? Response.json({ data: { format: "workflow", workflow: value } }) : new Response(blob);
    }) as typeof fetch;
    const first = await loadPublicWorkflow("tutorial", defaultConfig, { x: 0, y: 0 }, new AbortController().signal);
    const second = await loadPublicWorkflow("tutorial", defaultConfig, { x: 300, y: 200 }, new AbortController().signal);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    expect(first.nodes.map(node => node.id).some(id => second.nodes.some(node => node.id === id))).toBe(false);
    expect(calls.filter(url => url === "/api/library/tutorials/tutorial")).toHaveLength(2);
    expect(calls.every(url => url.startsWith("/api/library/"))).toBe(true);
    first.release(); second.release();
    globalThis.fetch = (async () => Response.json({ message: "内容不存在或已下架" }, { status: 404 })) as typeof fetch;
    await expect(loadPublicWorkflow("tutorial", defaultConfig, { x: 0, y: 0 }, new AbortController().signal)).rejects.toThrow("已下架");
    expect(keys).toHaveLength(2);
});

test("administrator workflow list preserves search, paging, summaries and request cancellation", async () => {
    const controller = new AbortController(), calls: Array<{ url: string; options?: RequestInit }> = [];
    const summary = { items: [{ id: "draft", published: false, data: { title: "示例流程", format: "workflow", workflowSummary: { nodeCount: 3, connectionCount: 1 } } }], total: 21, tags: [], categories: [] };
    globalThis.fetch = (async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), options }); return Response.json(summary); }) as typeof fetch;
    expect(await adminApi.fetchAdminWorkflows({ keyword: "图 文&流程", page: 2, pageSize: 20 }, controller.signal)).toEqual(summary);
    const url = new URL(calls[0].url, "http://localhost");
    expect(url.pathname).toBe("/api/admin/tutorials");
    expect(Object.fromEntries(url.searchParams)).toEqual({ keyword: "图 文&流程", page: "2", pageSize: "20", format: "workflow" });
    expect(calls[0].options?.signal).toBe(controller.signal);
    expect(calls[0].options?.cache).toBe("no-store");
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => { options?.signal?.throwIfAborted(); return Response.json(summary); }) as typeof fetch;
    controller.abort();
    await expect(adminApi.fetchAdminWorkflows({}, controller.signal)).rejects.toThrow();
});

test("a public workflow copied into a tutorial draft survives recovery and republishes independent nodes and media", async () => {
    const { value, blob } = await audioFlow(), source = structuredClone(value), blobs = new Map<string, Blob>(), drafts = new Map<string, unknown>();
    const saveMedia = spyOn(fileStorage, "setMediaBlob").mockImplementation(async (key, content) => { blobs.set(key, content); return `blob:${key}`; });
    const getMedia = spyOn(fileStorage, "getMediaBlob").mockImplementation(async key => blobs.get(key) || null);
    const saveDraft = spyOn(workflowDrafts, "setItem").mockImplementation(async (key, draft) => { drafts.set(key, structuredClone(draft)); return draft; });
    const readDraft = spyOn(workflowDrafts, "getItem").mockImplementation(async <T>(key: string) => (drafts.get(key) as T | undefined) ?? null);
    const iterate = spyOn(workflowDrafts, "iterate").mockImplementation(async iterator => { for (const [key, draft] of drafts) iterator(draft, key, 1); return undefined; });
    const upload = spyOn(adminApi, "uploadPublicFile").mockResolvedValue({ id: value.media[0].mediaId, url: workflowMediaUrl(value.media[0].mediaId), ...value.media[0] });
    restores.push(() => saveMedia.mockRestore(), () => getMedia.mockRestore(), () => saveDraft.mockRestore(), () => readDraft.mockRestore(), () => iterate.mockRestore(), () => upload.mockRestore());
    const requests: string[] = [];
    globalThis.fetch = (async (url: unknown) => { requests.push(String(url)); return String(url).startsWith("/api/library/tutorials/") ? Response.json({ data: { format: "workflow", workflow: value } }) : new Response(blob); }) as typeof fetch;
    const before = emptyWorkflowDraft({ title: "组合流程" });
    before.project.nodes = [{ id: "existing", type: "text", title: "已有节点", position: { x: 0, y: 0 }, width: 100, height: 80 }];
    const write = workflowDraftWriter("editing-tutorial"), next = structuredClone(before);
    for (const center of [{ x: 400, y: 300 }, { x: 800, y: 500 }]) {
        const copy = await loadPublicWorkflow("source", defaultConfig, center, new AbortController().signal);
        next.project.nodes.push(...copy.nodes); next.project.connections.push(...copy.connections); next.dirty = true;
        await write(next); copy.release();
    }
    const recovered = await workflowDrafts.getItem<typeof next>("editing-tutorial");
    expect(recovered).toEqual(next); expect(recovered!.dirty).toBe(true);
    expect(recovered!.project.id.startsWith("workflow-draft:")).toBe(true);
    expect(before.project.nodes).toHaveLength(1);
    const nodes = recovered!.project.nodes, ids = new Set(nodes.map(node => node.id));
    expect(ids.size).toBe(1 + value.nodes.length * 2);
    expect(new Set(recovered!.project.connections.map(edge => edge.id)).size).toBe(2);
    for (const edge of recovered!.project.connections) { expect(ids.has(edge.fromNodeId)).toBe(true); expect(ids.has(edge.toNodeId)).toBe(true); }
    const retained = fileStorage.collectMediaStorageKeys(await workflowMediaRetention());
    expect(blobs.size).toBe(2); for (const key of blobs.keys()) { expect(retained.has(key)).toBe(true); expect(await (await fileStorage.getMediaBlob(key))!.text()).toBe(await blob.text()); }
    const published = await publishWorkflow(nodes, recovered!.project.connections, defaultConfig, [], new AbortController().signal);
    expect(published.nodes).toHaveLength(nodes.length); expect(published.media).toHaveLength(1); expect(upload).toHaveBeenCalledTimes(1);
    for (const node of published.nodes.filter(node => node.type === "config")) {
        const edge = published.connections.find(edge => edge.toNodeId === node.id)!;
        expect(node.metadata?.prompt).toBe(`@[node:${edge.fromNodeId}]`);
        expect(node.metadata?.groupId).toBe(published.nodes.find(item => item.id === edge.fromNodeId)?.metadata?.groupId);
    }
    expect(requests.every(url => url.startsWith("/api/library/"))).toBe(true); expect(value).toEqual(source);
});

test("failed or cancelled preparation cleans partial media and never changes the existing document", async () => {
    const { value, blob } = await audioFlow(2), existing = flow(), original = structuredClone(existing), removed: string[][] = [];
    const save = spyOn(fileStorage, "setMediaBlob").mockImplementation(async key => `blob:${key}`);
    const remove = spyOn(fileStorage, "deleteStoredMedia").mockImplementation(async keys => { removed.push([...keys]); });
    const removeImages = spyOn(imageStorage, "deleteStoredImages").mockResolvedValue(undefined);
    restores.push(() => save.mockRestore(), () => remove.mockRestore(), () => removeImages.mockRestore());
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1 ? new Response(blob) : new Response(null, { status: 404 })) as typeof fetch;
    await expect(materializeWorkflow(value, defaultConfig, { x: 0, y: 0 }, new AbortController().signal)).rejects.toThrow("下载失败");
    expect(removed[0]).toHaveLength(1); expect(existing).toEqual(original);
    const controller = new AbortController();
    globalThis.fetch = (async () => new Response(blob)) as typeof fetch;
    save.mockImplementation(async key => { controller.abort(); return `blob:${key}`; });
    await expect(materializeWorkflow(value, defaultConfig, { x: 0, y: 0 }, controller.signal)).rejects.toThrow();
    expect(removed[1]).toHaveLength(1); expect(existing).toEqual(original);
    const invalid = flow(); invalid.nodes[0].type = "plugin:unknown" as never;
    await expect(materializeWorkflow(invalid, defaultConfig, { x: 0, y: 0 }, new AbortController().signal)).rejects.toThrow("插件");
    const bad = flow(); bad.connections[0].toNodeId = "missing";
    expect(() => instantiateWorkflow(bad, new Map(), () => "", { x: 0, y: 0 })).toThrow("不存在的节点");
    const corrupt = flow(); corrupt.nodes[2].metadata!.references = 42 as never;
    await expect(materializeWorkflow(corrupt, defaultConfig, { x: 0, y: 0 }, new AbortController().signal)).rejects.toThrow("结构损坏");
});

test("media checksums reject corrupt bytes before any local write", async () => {
    const { value } = await audioFlow();
    const save = spyOn(fileStorage, "setMediaBlob").mockResolvedValue("blob:unused"), remove = spyOn(fileStorage, "deleteStoredMedia").mockResolvedValue(undefined), removeImages = spyOn(imageStorage, "deleteStoredImages").mockResolvedValue(undefined);
    restores.push(() => save.mockRestore(), () => remove.mockRestore(), () => removeImages.mockRestore());
    globalThis.fetch = (async () => new Response(new Blob(["corrupt"], { type: "audio/mpeg" }))) as typeof fetch;
    await expect(materializeWorkflow(value, defaultConfig, { x: 0, y: 0 }, new AbortController().signal)).rejects.toThrow("校验失败");
    expect(save).not.toHaveBeenCalled();
});

test("publishing strips runtime state and reuses matching uploaded examples, missing local media blocks saving", async () => {
    const { value, blob } = await audioFlow();
    const source: CanvasNodeData[] = [{ ...value.nodes.at(-1)!, metadata: { ...value.nodes.at(-1)!.metadata, content: "blob:local", storageKey: "audio:source", references: ["audio:source"], model: "private::audio-model", status: "loading", errorDetails: "error", videoTaskId: "task" } }];
    const get = spyOn(fileStorage, "getMediaBlob").mockResolvedValue(blob), upload = spyOn(adminApi, "uploadPublicFile").mockRejectedValue(new Error("should reuse"));
    restores.push(() => get.mockRestore(), () => upload.mockRestore());
    const published = await publishWorkflow(source, [], defaultConfig, value.media, new AbortController().signal);
    expect(published.models[source[0].id]).toEqual({ name: "audio-model", capability: "audio" });
    expect(published.nodes[0].metadata?.references).toEqual([workflowMediaUrl(value.media[0].mediaId)]);
    expect(published.nodes[0].metadata?.content).toBe(workflowMediaUrl(value.media[0].mediaId));
    expect(upload).not.toHaveBeenCalled();
    for (const key of ["model", "videoTaskId", "errorDetails"]) expect(published.nodes[0].metadata).not.toHaveProperty(key);
    expect(published.nodes[0].metadata?.status).toBe("success");
    get.mockResolvedValue(null);
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    await expect(publishWorkflow(source, [], defaultConfig, [], new AbortController().signal)).rejects.toThrow("读取失败");
});

test("draft writes serialize, keep the latest pending content, and move new drafts without reviving the old key", async () => {
    const calls: Array<[string, unknown]> = [];
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const saved = spyOn(workflowDrafts, "setItem").mockImplementation(async (key, value) => { calls.push([key, value]); if (calls.length === 1) await gate; return value; });
    const removed = spyOn(workflowDrafts, "removeItem").mockResolvedValue(undefined);
    restores.push(() => saved.mockRestore(), () => removed.mockRestore());
    const write = workflowDraftWriter("new"), first = emptyWorkflowDraft({ title: "first" }), latest = emptyWorkflowDraft({ title: "latest" });
    const pending = write(first);
    void write(emptyWorkflowDraft({ title: "superseded" }));
    const archived = write.archive("tutorial-id"); void write(latest); unblock(); await pending; await archived;
    expect(calls).toEqual([["new", first], ["new", latest], ["tutorial-id", latest]]);
    expect(removed).toHaveBeenCalledWith("new");
    await write(first); expect(calls.at(-1)?.[0]).toBe("tutorial-id");
    expect(first.project.id.startsWith("workflow-draft:")).toBe(true);
    const iterate = spyOn(workflowDrafts, "iterate").mockImplementation(async iterator => { iterator(latest, "tutorial-id", 1); return undefined; });
    restores.push(() => iterate.mockRestore());
    const active = { storageKey: "audio:preparing" }, release = retainWorkflowMedia(active);
    expect(isWorkflowMediaRetained(active.storageKey)).toBe(true);
    const retained = await workflowMediaRetention();
    expect(retained).toContain(active); expect(retained).toContain(latest.project);
    release(); expect(await workflowMediaRetention()).not.toContain(active);
    expect(isWorkflowMediaRetained(active.storageKey)).toBe(false);
});

test("new and existing saves acknowledge the server version and preserve changes completed during saving", () => {
    for (const tutorialId of [undefined, "existing-tutorial"]) {
        const before = { ...emptyWorkflowDraft({ title: "Before" }), tutorialId, revision: tutorialId ? 3 : undefined, dirty: true };
        const saved = { ...before, tutorialId: tutorialId || "new-tutorial", revision: tutorialId ? 4 : 1, data: { ...before.data, title: "Saved" } };
        const clean = mergeSavedWorkflowDraft(before, before, saved);
        expect(clean.dirty).toBe(false);
        expect(clean.tutorialId).toBe(saved.tutorialId);
        expect(clean.revision).toBe(saved.revision);
        expect(clean.data.title).toBe("Saved");
        const latest = { ...before, project: { ...before.project, nodes: [{ ...flow().nodes[1], title: "Late result" }] }, data: { ...before.data, title: "Late edit" }, published: true, position: 12 };
        const merged = mergeSavedWorkflowDraft(before, latest, saved);
        expect(merged.dirty).toBe(true);
        expect(merged.project).toBe(latest.project);
        expect(merged.data.title).toBe("Late edit");
        expect(merged.published).toBe(true);
        expect(merged.position).toBe(12);
        expect(merged.revision).toBe(saved.revision);
        expect(merged.tutorialId).toBe(saved.tutorialId);
        expect(mergeSavedWorkflowDraft(before, { ...before, data: { ...before.data, description: "Late description" } }, saved).dirty).toBe(true);
    }
});

test("archiving waits for late changes before removing the new draft and keeps independent media references", async () => {
    const items = new Map<string, unknown>();
    let begin!: () => void, unblock!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const saved = spyOn(workflowDrafts, "setItem").mockImplementation(async (key, value) => {
        if (key === "created-tutorial" && !items.has(key)) { begin(); await gate; }
        items.set(key, structuredClone(value)); return value;
    });
    const removed = spyOn(workflowDrafts, "removeItem").mockImplementation(async key => { expect(items.has("created-tutorial")).toBe(true); items.delete(key); });
    restores.push(() => saved.mockRestore(), () => removed.mockRestore());
    const write = workflowDraftWriter("new"), draft = { ...emptyWorkflowDraft(), tutorialId: "created-tutorial", revision: 1 };
    await write(draft);
    const archived = write.archive(draft.tutorialId);
    await started;
    const latest = { ...draft, dirty: true, project: { ...draft.project, nodes: [{ ...flow().nodes[1], metadata: { storageKey: "image:retained" } }] } };
    const pending = write(latest); unblock(); await archived; await pending;
    expect(items.has("new")).toBe(false);
    expect(items.get(draft.tutorialId)).toEqual(latest);
});

test("failed draft archival retains the server ID and revision for refresh or retry without another create", async () => {
    for (const failure of ["new", "created-tutorial", "remove"]) {
        const items = new Map<string, unknown>();
        let fail = false;
        const saved = spyOn(workflowDrafts, "setItem").mockImplementation(async (key, value) => {
            if (fail && key === failure) throw new Error("disk unavailable");
            items.set(key, structuredClone(value)); return value;
        });
        const removed = spyOn(workflowDrafts, "removeItem").mockImplementation(async key => {
            if (fail && failure === "remove") throw new Error("disk unavailable");
            items.delete(key);
        });
        const write = workflowDraftWriter("new"), draft = { ...emptyWorkflowDraft(), tutorialId: "created-tutorial", revision: 1, dirty: true };
        try {
            await write(draft); fail = true;
            await expect(write.archive(draft.tutorialId)).rejects.toThrow("disk unavailable");
            expect(items.get("new")).toEqual(draft);
            fail = false; await write.archive(draft.tutorialId);
            expect(items.has("new")).toBe(false);
            expect(items.get(draft.tutorialId)).toEqual(draft);
        } finally { saved.mockRestore(); removed.mockRestore(); }
    }
});

test("editing an existing tutorial flushes its draft without removing it or another tutorial draft", async () => {
    const saved = spyOn(workflowDrafts, "setItem").mockImplementation(async (_key, value) => value);
    const removed = spyOn(workflowDrafts, "removeItem").mockResolvedValue(undefined);
    restores.push(() => saved.mockRestore(), () => removed.mockRestore());
    const write = workflowDraftWriter("existing-tutorial"), draft = { ...emptyWorkflowDraft(), tutorialId: "existing-tutorial", revision: 4 };
    await write(draft); await write.archive(draft.tutorialId);
    expect(saved.mock.calls.every(([key]) => key === draft.tutorialId)).toBe(true);
    expect(removed).not.toHaveBeenCalled();
});
