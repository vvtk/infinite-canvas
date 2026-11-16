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
import { refreshSystemChannel } from "@/services/api/system-channel";
import { stopCloudSync } from "@/services/cloud-sync";
import { useUserStore } from "@/stores/use-user-store";

let signingOut: Promise<void> | undefined;
let credentialGeneration = 0;
const channelRequests = new Map<string, Promise<void>>();
export function setupAccountChannel() {
    const account = getAccount();
    if (signingOut || account === "guest" || !useUserStore.getState().user) return Promise.resolve();
    const pending = channelRequests.get(account);
    if (pending) return pending;
    const request = loadAccountChannel(account, credentialGeneration).finally(() => channelRequests.delete(account));
    channelRequests.set(account, request);
    return request;
}
async function loadAccountChannel(account: string, generation: number) {
    if (!useConfigStore.persist.hasHydrated()) await new Promise<void>((resolve) => { const unsubscribe = useConfigStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); }); });
    if (generation !== credentialGeneration || signingOut) return;
    const state = useConfigStore.getState();
    const existing = state.config.channels.find((channel) => channel.managedAccount === account);
    const authorizationId = useUserStore.getState().user?.authorizationId;
    const credentials = existing?.apiKey && existing.baseUrl && authorizationId && existing.managedAuthorizationId === authorizationId ? existing : await cloudRequest<{ apiKey: string; baseUrl: string }>("/auth/credentials", {});
    if (getAccount() !== account || generation !== credentialGeneration || signingOut) return;
    const channel = { id: existing?.id || `llmroam-${account}`, name: "LLMRoam", baseUrl: credentials.baseUrl, apiKey: credentials.apiKey, apiFormat: "openai" as const, models: existing?.models || [], managedAccount: account, managedAuthorizationId: authorizationId };
    const [models] = await Promise.all([fetchChannelModels(channel), refreshSystemChannel()]);
    if (getAccount() !== account || generation !== credentialGeneration || signingOut) return;
    channel.models = models.map((name) => existing?.models.find((model) => model.name === name) || { name, capability: guessCapability(name) });
    const current = useConfigStore.getState().config;
    const channels = [...current.channels.filter((item) => item.managedAccount !== account), channel];
    useConfigStore.setState({ systemCatalog: models, config: { ...current, channels, models: modelOptionsFromChannels(channels) } });
}
export function logoutAccount() {
    if (signingOut) return signingOut;
    signingOut = (async () => {
        await stopCloudSync();
        const { projects, deletedProjects } = useCanvasStore.getState();
        const saved = await Promise.allSettled([
            localForageStorage.setItem("infinite-canvas:canvas_store", JSON.stringify({ state: { projects, deletedProjects }, version: 0 })),
            clearAccountCredential(),
        ]);
        useUserStore.getState().clearSession();
        try { await cloudRequest("/auth/logout", {}, "POST", null); }
        finally {
            localStorage.removeItem("canvas:last-account");
            const failed = saved.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
            window.location.assign("/");
        }
    })();
    return signingOut;
}
export async function clearAccountCredential() {
    credentialGeneration++;
    if (!useConfigStore.persist.hasHydrated()) await new Promise<void>((resolve) => { const unsubscribe = useConfigStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); }); });
    const state = useConfigStore.getState();
    const ownedKeys = new Set(state.config.channels.filter((item) => item.managedAccount === getAccount()).map((item) => item.apiKey));
    const config = { ...state.config, apiKey: ownedKeys.has(state.config.apiKey) ? "" : state.config.apiKey, channels: state.config.channels.map((item) => item.managedAccount === getAccount() ? { ...item, apiKey: "" } : item) };
    useConfigStore.setState({ config, systemSnapshot: null, systemCatalog: [], systemError: "" });
    await localForageStorage.setItem(CONFIG_STORE_KEY, JSON.stringify({ state: { config, webdav: state.webdav, systemOverrides: state.systemOverrides }, version: 0 }));
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
