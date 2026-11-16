import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { useSiteStore, privateChannelsHidden } from "@/stores/use-site-store";
import { refreshSystemChannel } from "@/services/api/system-channel";
import { logoutAccount } from "@/services/account";
import { useUserStore } from "@/stores/use-user-store";
import { updateCloudSyncAvailability } from "@/services/cloud-sync";
import {isAdminRole} from "../../../../shared/roles";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const pendingCredentials = useRef<{ baseUrl: string | null; apiKey: string | null } | null>(null);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const site = useSiteStore(state => state.settings);
    const user = useUserStore(state => state.user);

    useEffect(() => {
        const expire = () => {
            if (useUserStore.getState().user) void logoutAccount().catch(error => message.error(error instanceof Error ? error.message : "退出登录失败"));
        };
        window.addEventListener("canvas-session-expired", expire);
        return () => window.removeEventListener("canvas-session-expired", expire);
    }, [message]);

    useEffect(() => { void useSiteStore.getState().load(); }, []);
    useEffect(() => { updateCloudSyncAvailability(); }, [site?.userCloudStorageEnabled, user?.id]);
    useEffect(() => {
        const refresh = () => { void refreshSystemChannel(); void useSiteStore.getState().load(); };
        window.addEventListener("focus", refresh);
        window.addEventListener("online", refresh);
        return () => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
    }, []);

    useEffect(() => {
        if (handledConfigParams.current) return;
        if (!pendingCredentials.current) {
            const searchParams = new URLSearchParams(window.location.search);
            const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
            const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
            if (!baseUrl && !apiKey) return;
            pendingCredentials.current = { baseUrl, apiKey };
            searchParams.delete("baseUrl");
            searchParams.delete("baseurl");
            searchParams.delete("apiKey");
            searchParams.delete("apikey");
            window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        }
        if (!site && !user?.isAdmin && !isAdminRole(user?.role)) return;
        handledConfigParams.current = true;
        const { baseUrl, apiKey } = pendingCredentials.current;
        pendingCredentials.current = null;
        if (privateChannelsHidden()) return;
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [importChannelCredentials, message, openConfigDialog, t, site, user?.isAdmin, user?.role]);

    return <>{children}</>;
}
