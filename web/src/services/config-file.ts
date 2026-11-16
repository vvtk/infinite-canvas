import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { modelOptionsFromChannels, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { sanitizeSystemOverrides, type SystemPreferences } from "../../../shared/system-channel";
import { privateChannelsHidden, useSiteStore } from "@/stores/use-site-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    systemOverrides: Partial<SystemPreferences>;
};

export function exportAppConfig() {
    const { config: storedConfig, webdav, systemOverrides } = useConfigStore.getState();
    const managedKeys = new Set(storedConfig.channels.filter((item) => item.managedAccount).map((item) => item.apiKey));
    const channels = storedConfig.channels.filter((item) => !item.managedAccount);
    const config = { ...storedConfig, apiKey: managedKeys.has(storedConfig.apiKey) ? "" : storedConfig.apiKey, channels, models: modelOptionsFromChannels(channels) };
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, systemOverrides };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !Array.isArray(data.config.channels)) throw new Error(i18n.t("config.invalidFile"));
    if (!useSiteStore.getState().settings) await useSiteStore.getState().load();
    const current = useConfigStore.getState().config;
    const managedChannels = current.channels.filter(channel => channel.managedAccount);
    const channels = [...data.config.channels.filter(channel => !channel.managedAccount && !managedChannels.some(current => current.id === channel.id)), ...managedChannels];
    const config = privateChannelsHidden() || !useSiteStore.getState().settings
        ? { ...data.config, channels: current.channels, models: current.models, baseUrl: current.baseUrl, apiKey: current.apiKey, apiFormat: current.apiFormat, channelMode: current.channelMode, model: current.model, imageModel: current.imageModel, videoModel: current.videoModel, textModel: current.textModel, audioModel: current.audioModel }
        : { ...data.config, channels, models: modelOptionsFromChannels(channels) };
    useConfigStore.setState({ config, webdav: data.webdav, systemOverrides: sanitizeSystemOverrides(data.systemOverrides) });
}
