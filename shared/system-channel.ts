export type SystemCapability = "image" | "video" | "text" | "audio";
export type SystemModel = { name: string; capability: SystemCapability; script?: string };
export type SystemPreferences = {
    imageModel: string; videoModel: string; textModel: string; audioModel: string;
    quality: string; size: string; background: string; count: string; canvasImageCount: string;
    videoSeconds: string; vquality: string; videoGenerateAudio: string; videoWatermark: string; videoMode: string;
    audioVoice: string; audioFormat: string; audioSpeed: string; audioInstructions: string;
    reasoningEffort: "auto" | "low" | "medium" | "high" | "xhigh";
    nodeRegenerateBehavior: "new-node" | "overwrite";
    streamText: boolean; returnBase64: boolean;
    imageSystemPrompt: string; videoSystemPrompt: string; textSystemPrompt: string;
};
export type SystemChannelConfig = { models: SystemModel[]; enabledModels: string[]; defaults: SystemPreferences };
export type SystemChannelSnapshot = { data: SystemChannelConfig; revision: number };
export const systemModelKeys = ["imageModel", "videoModel", "textModel", "audioModel"] as const;
export const defaultSystemPreferences: SystemPreferences = {
    imageModel: "", videoModel: "", textModel: "", audioModel: "",
    quality: "auto", size: "1:1", background: "", count: "1", canvasImageCount: "3",
    videoSeconds: "6", vquality: "720", videoGenerateAudio: "true", videoWatermark: "false", videoMode: "frames",
    audioVoice: "longanhuan_v3.1", audioFormat: "mp3", audioSpeed: "1", audioInstructions: "",
    reasoningEffort: "auto", nodeRegenerateBehavior: "new-node", streamText: true, returnBase64: true,
    imageSystemPrompt: "", videoSystemPrompt: "", textSystemPrompt: "",
};
export const emptySystemChannel: SystemChannelConfig = { models: [], enabledModels: [], defaults: defaultSystemPreferences };

export function sanitizeSystemOverrides(value: unknown): Partial<SystemPreferences> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, entry]) => Object.hasOwn(defaultSystemPreferences, key) && typeof entry === typeof defaultSystemPreferences[key as keyof SystemPreferences]));
}

export function pruneSystemModels(data: SystemChannelConfig): SystemChannelConfig {
    const enabledModels = data.enabledModels.filter(name => data.models.some(model => model.name === name));
    const defaults = { ...data.defaults };
    for (const key of systemModelKeys) if (!data.models.some(model => model.name === defaults[key] && enabledModels.includes(model.name) && key === `${model.capability}Model`)) defaults[key] = "";
    return { ...data, enabledModels, defaults };
}
