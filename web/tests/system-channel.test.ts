import { afterAll, beforeEach, expect, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";
import { defaultSystemPreferences, type SystemChannelSnapshot } from "../../shared/system-channel";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { defaultConfig, getEffectiveConfig, resolveModelRequestConfig, resolveModelScript, selectableModelsByCapability, useConfigStore } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const originalState = useConfigStore.getState();
const snapshot: SystemChannelSnapshot = {
    revision: 1,
    data: {
        models: [{ name: "image-a", capability: "image", script: "return [];" }, { name: "image-b", capability: "image" }, { name: "text-a", capability: "text" }, { name: "hidden", capability: "image" }],
        enabledModels: ["image-a", "image-b", "text-a"],
        defaults: { ...defaultSystemPreferences, imageModel: "image-a", textModel: "text-a", quality: "high", canvasImageCount: "5", imageSystemPrompt: "image default", textSystemPrompt: "text default" },
    },
};
const config: AiConfig = {
    ...defaultConfig, model: "system::old-default", imageModel: "system::old-default", textModel: "system::text-a", quality: "low", size: "16:9",
    channels: [defaultConfig.channels[0], { id: "system", name: "LLMRoam", managedAccount: "alice", baseUrl: "https://example.com", apiKey: "account-key", apiFormat: "openai", models: [{ name: "image-a", capability: "text" }, { name: "text-a", capability: "text" }, { name: "hidden", capability: "image" }] }],
};
beforeEach(() => useConfigStore.setState({ config, systemSnapshot: snapshot, systemCatalog: ["image-a", "text-a", "hidden"], systemOverrides: {} }));
afterAll(() => {
    useConfigStore.setState(originalState);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("model selection uses the exposed/upstream intersection and administrator capability and script", () => {
    expect(selectableModelsByCapability(config, "image")).toEqual(["system::image-a"]);
    expect(resolveModelScript(config, "system::image-a")).toBe("return [];");
    useConfigStore.setState({ systemSnapshot: null });
    expect(selectableModelsByCapability(config, "image")).toEqual([]);
    expect(() => resolveModelRequestConfig(config, "system::hidden")).toThrow();
});

test("model options exclude preset and incomplete channels without altering saved selections", () => {
    expect(selectableModelsByCapability(defaultConfig)).toEqual([]);
    const channel = { ...defaultConfig.channels[0], apiKey: "configured-key" };
    const ready = { ...defaultConfig, channels: [channel] };
    expect(selectableModelsByCapability(ready, "video")).toEqual([defaultConfig.videoModel]);
    expect(selectableModelsByCapability(ready)).toEqual(defaultConfig.models);
    for (const incomplete of [{ ...channel, apiKey: " " }, { ...channel, baseUrl: " " }, { ...channel, models: [] }]) {
        expect(selectableModelsByCapability({ ...ready, channels: [incomplete] })).toEqual([]);
    }
    expect(selectableModelsByCapability({ ...config, channels: config.channels.map(channel => ({ ...channel, apiKey: "" })) })).toEqual([]);
    expect(useConfigStore.getState().config.imageModel).toBe(config.imageModel);
});

test("unmodified model and prompt defaults follow the server; sparse false and empty overrides can be reset", () => {
    expect(getEffectiveConfig(config).imageModel).toBe("system::image-a");
    const update = useConfigStore.getState().updateSystemPreference;
    update("imageSystemPrompt", ""); update("returnBase64", false);
    expect(getEffectiveConfig(config).systemPrompt).toBe("");
    expect(getEffectiveConfig(config).returnBase64).toBe(false);
    update("imageSystemPrompt", undefined);
    expect(getEffectiveConfig(config).systemPrompt).toBe("image default");
    useConfigStore.setState({ systemSnapshot: { ...snapshot, revision: 2, data: { ...snapshot.data, defaults: { ...snapshot.data.defaults, imageSystemPrompt: "updated" } } } });
    expect(getEffectiveConfig(config).systemPrompt).toBe("updated");
    expect(useConfigStore.getState().systemOverrides).toEqual({ returnBase64: false });
});

test("node values win over system preferences, while a private node retains private parameters", () => {
    useConfigStore.getState().updateSystemPreference("quality", "medium");
    const node = { id: "n", type: CanvasNodeType.Image, title: "", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "system::image-a", quality: "low", count: 2 } };
    const selected = buildGenerationConfig(getEffectiveConfig(config), node, "image");
    expect(selected.quality).toBe("low"); expect(selected.count).toBe("2");
    expect(resolveModelRequestConfig(selected, selected.model).quality).toBe("low");
    const privateSelection = buildGenerationConfig(getEffectiveConfig(config), { ...node, metadata: { model: defaultConfig.imageModel } }, "image");
    expect(privateSelection.quality).toBe("low"); expect(privateSelection.size).toBe("16:9");
    expect(buildGenerationConfig(config, undefined, "image").count).toBe("5");
});

test("workbench updates are local overrides for system models and ordinary settings for private models", () => {
    const update = useConfigStore.getState().updateEffectiveConfig;
    update("image", "quality", "medium");
    expect(useConfigStore.getState().systemOverrides).toEqual({ quality: "medium" });
    expect(useConfigStore.getState().config.quality).toBe("low");
    update("image", "imageModel", defaultConfig.imageModel);
    update("image", "quality", "high");
    expect(useConfigStore.getState().config.quality).toBe("high");
    expect(useConfigStore.getState().systemOverrides.quality).toBe("medium");
});

test("unavailable saved models block requests without replacing the saved selection", () => {
    const selected = buildGenerationConfig(config, { id: "v", type: CanvasNodeType.Video, title: "", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "system::removed", videoTaskId: "task" } }, "video");
    expect(selected.model).toBe("system::removed");
    expect(() => resolveModelRequestConfig(selected, selected.model)).toThrow();
    expect(JSON.stringify(getEffectiveConfig(config))).not.toContain("privateConfig");
});

test("a stale personal default cannot invoke a model whose administrator capability changed", () => {
    useConfigStore.getState().updateSystemPreference("imageModel", "text-a");
    const selected = buildGenerationConfig(config, undefined, "image");
    expect(selected.model).toBe("system::text-a");
    expect(useConfigStore.getState().isAiConfigReady(selected, selected.model)).toBe(false);
    expect(() => resolveModelRequestConfig(selected, selected.model)).toThrow();
});

test("private-channel imports preserve existing channels and model selections when hidden, but administrators can import", async () => {
    const { useSiteStore } = await import("../src/stores/use-site-store");
    const { useUserStore } = await import("../src/stores/use-user-store");
    const { importAppConfig } = await import("../src/services/config-file");
    const site = useSiteStore.getState();
    const previousUser = useUserStore.getState().user;
    useSiteStore.setState({ settings: { siteName: "test", description: "", logoUrl: "", announcement: "", hidePrivateChannels: true, userCloudStorageEnabled: true, publicContent: { prompts: true, tutorials: true, skills: true, assets: true } } });
    const incoming = { ...config, quality: "high", apiKey: "imported-key", channels: [{ ...config.channels[0], id: "imported", apiKey: "imported-key" }], imageModel: "imported::image" };
    const file = new File([JSON.stringify({ app: "infinite-canvas", version: 1, config: incoming, webdav: originalState.webdav, systemOverrides: { size: "1:1" } })], "config.json");
    try {
        for (const user of [null, { id: "alice", username: "alice", displayName: "Alice", avatarUrl: "", role: 1 }]) {
            useUserStore.setState({ user });
            useConfigStore.setState({ config });
            await importAppConfig(file);
            expect(useConfigStore.getState().config.channels).toEqual(config.channels);
            expect(useConfigStore.getState().config.imageModel).toBe(config.imageModel);
            expect(useConfigStore.getState().config.quality).toBe("high");
            expect(useConfigStore.getState().systemOverrides).toEqual({ size: "1:1" });
        }
        useUserStore.setState({ user: { id: "admin", username: "admin", displayName: "Admin", avatarUrl: "", role: 10 } });
        await importAppConfig(file);
        expect(useConfigStore.getState().config.channels.some(channel => channel.id === "imported")).toBe(true);
        expect(useConfigStore.getState().config.channels.find(channel => channel.managedAccount)?.apiKey).toBe("account-key");
    } finally {
        useSiteStore.setState(site);
        useUserStore.setState({ user: previousUser });
    }
});
