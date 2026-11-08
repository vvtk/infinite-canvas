import localforage from "localforage";
import { nanoid } from "nanoid";
import { getAccount } from "@/lib/account-storage";
import { localForageStorage } from "@/lib/localforage-storage";
import { cloudRequest } from "@/services/api/cloud";
import { cloudMeta, waitForCloudData } from "@/services/cloud-data";
import { fetchChannelModels } from "@/services/api/image";
import { useConfigStore, modelOptionsFromChannels, guessCapability, CONFIG_STORE_KEY } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

export async function setupAccountChannel() {
    if (!useConfigStore.persist.hasHydrated()) await new Promise<void>((resolve) => { const unsubscribe = useConfigStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); }); });
    const credentials = await cloudRequest<{ apiKey: string; baseUrl: string }>("/auth/credentials", {});
    const account = getAccount();
    const state = useConfigStore.getState();
    const existing = state.config.channels.find((channel) => channel.managedAccount === account);
    const channel = { id: existing?.id || `llmroam-${account}`, name: "LLMRoam", baseUrl: credentials.baseUrl, apiKey: credentials.apiKey, apiFormat: "openai" as const, models: existing?.models || [], managedAccount: account };
    const models = await fetchChannelModels(channel);
    channel.models = models.map((name) => existing?.models.find((model) => model.name === name) || { name, capability: guessCapability(name) });
    const current = useConfigStore.getState().config;
    const channels = [...current.channels.filter((item) => item.managedAccount !== account), channel];
    useConfigStore.setState({ config: { ...current, channels, models: modelOptionsFromChannels(channels) } });
}
export async function clearAccountCredential() {
    const state = useConfigStore.getState();
    const ownedKeys = new Set(state.config.channels.filter((item) => item.managedAccount === getAccount()).map((item) => item.apiKey));
    const config = { ...state.config, apiKey: ownedKeys.has(state.config.apiKey) ? "" : state.config.apiKey, channels: state.config.channels.map((item) => item.managedAccount === getAccount() ? { ...item, apiKey: "" } : item) };
    useConfigStore.setState({ config });
    await localForageStorage.setItem(CONFIG_STORE_KEY, JSON.stringify({ state: { config, webdav: state.webdav }, version: 0 }));
}
const guestState = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
export async function hasGuestData() {
    if (await cloudMeta.getItem("guest-import-decided")) return false;
    for (const key of ["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]) {
        const value = await guestState.getItem<string>(key);
        if (value && /"id"\s*:/.test(value)) return true;
    }
    for (const storeName of ["image_generation_logs", "video_generation_logs"]) if (await localforage.createInstance({ name: "infinite-canvas", storeName }).length()) return true;
    return false;
}
export async function importGuestData() {
    await waitForCloudData();
    // Import only business domains, never API credentials or local Agent settings.
    for (const storeName of ["image_files", "media_files", "image_generation_logs", "video_generation_logs"]) {
        const source = localforage.createInstance({ name: "infinite-canvas", storeName });
        const destination = localforage.createInstance({ name: `infinite-canvas:account:${getAccount()}`, storeName });
        for (const key of await source.keys()) {
            const value = await source.getItem(key);
            if (await destination.getItem(key) === null) await destination.setItem(key, value);
        }
    }
    const canvas = await guestState.getItem<string>("infinite-canvas:canvas_store");
    if (canvas) {
        const incoming = JSON.parse(canvas).state.projects as CanvasProject[];
        const state = useCanvasStore.getState();
        state.replaceProjects([...state.projects, ...incoming.map((project) => ({ ...project, id: nanoid() }))], state.deletedProjects);
    }
    const assets = await guestState.getItem<string>("infinite-canvas:asset_store");
    if (assets) {
        const incoming = JSON.parse(assets).state.assets as Asset[];
        const state = useAssetStore.getState();
        state.replaceAssets([...state.assets, ...incoming.map((asset) => ({ ...asset, id: nanoid() }))]);
    }
    await cloudMeta.setItem("guest-import-decided", true);
    window.dispatchEvent(new CustomEvent("canvas-local-save"));
}
