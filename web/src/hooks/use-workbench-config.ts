import { useCallback, useMemo, useState } from "react";

import { decodeChannelModel, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

type WorkbenchSettings = { model?: string; channelId?: string; parameters: Partial<AiConfig> };

export function useWorkbenchConfig(capability: "image" | "video") {
    const [settings, setSettings] = useState<WorkbenchSettings>({ parameters: {} });
    const defaults = useEffectiveConfig(capability, settings.model);
    const modelKey = `${capability}Model` as const;
    const defaultModel = defaults[modelKey];
    const model = settings.model ?? defaultModel;
    const channelId = decodeChannelModel(model)?.channelId;
    const config = useMemo<AiConfig>(() => ({ ...defaults, ...(settings.channelId === channelId ? settings.parameters : {}), model, [modelKey]: model }), [defaults, settings, channelId, model, modelKey]);

    const updateConfig = useCallback(<K extends keyof AiConfig>(key: K, value: AiConfig[K]) => {
        setSettings(previous => {
            if (key === modelKey) {
                const model = value as string;
                const channelId = decodeChannelModel(model)?.channelId;
                return { model, channelId, parameters: previous.channelId === channelId ? previous.parameters : {} };
            }
            const channelId = decodeChannelModel(previous.model ?? defaultModel)?.channelId;
            return { ...previous, channelId, parameters: { ...(previous.channelId === channelId ? previous.parameters : {}), [key]: value } };
        });
    }, [defaultModel, modelKey]);

    return { config, updateConfig };
}
