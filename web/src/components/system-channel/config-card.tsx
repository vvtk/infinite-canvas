import { useEffect, useState } from "react";
import { Alert, App, Button } from "antd";
import { Cloud, LogIn, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUserStore } from "@/stores/use-user-store";
import { decodeChannelModel, useConfigStore } from "@/stores/use-config-store";
import { setupAccountChannel } from "@/services/account";
import { refreshSystemChannel } from "@/services/api/system-channel";
import { SystemPreferencesForm } from "./preferences-form";
import { systemModelKeys } from "../../../../shared/system-channel";

export function SystemChannelConfigCard() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const user = useUserStore(state => state.user);
    const channel = useConfigStore(state => user ? state.config.channels.find(item => item.managedAccount === user.id) : undefined);
    const snapshot = useConfigStore(state => state.systemSnapshot);
    const catalog = useConfigStore(state => state.systemCatalog);
    const overrides = useConfigStore(state => state.systemOverrides);
    const error = useConfigStore(state => state.systemError);
    const loading = useConfigStore(state => state.systemLoading);
    const active = useConfigStore(state => Boolean(channel && systemModelKeys.every(key => decodeChannelModel(state.config[key])?.channelId === channel.id)));
    const update = useConfigStore(state => state.updateSystemPreference);
    const [adding, setAdding] = useState(false);
    useEffect(() => { if (user) void refreshSystemChannel(); }, [user?.id]);
    const models = snapshot?.data.models.filter(model => snapshot.data.enabledModels.includes(model.name) && catalog.includes(model.name)) || [];
    const add = async () => {
        if (!user) {
            useConfigStore.getState().setConfigDialogOpen(false);
            useUserStore.getState().setLoginDialogOpen(true);
            return;
        }
        setAdding(true);
        try { await setupAccountChannel(); }
        catch (reason) { message.error(reason instanceof Error ? reason.message : "系统渠道加载失败"); }
        finally { setAdding(false); }
    };
    const useDefaults = () => {
        if (!user || !channel || !snapshot) return;
        useConfigStore.getState().activateSystemChannel(user.id);
        message.success("已使用系统渠道默认模型");
    };
    return <>
        <section className="mb-5 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-semibold"><Cloud className="size-4" />系统渠道</h2><p className="mt-1 text-xs text-muted-foreground">{user ? `登录账号专用渠道，当前可用 ${models.length} 个模型。模型请求由浏览器直连。` : "登录后使用管理员配置的模型和默认值。"}</p></div>{channel ? <Button disabled={!snapshot || active} onClick={useDefaults}>{active ? "已使用" : "使用此渠道"}</Button> : <Button icon={!user ? <LogIn className="size-4" /> : undefined} loading={Boolean(user) && (adding || loading)} onClick={() => void add()}>{!user ? t("account.login") : "添加系统渠道"}</Button>}</div>
            {error ? <Alert className="mt-3" type="error" showIcon title={error} action={<Button size="small" onClick={() => void add()}>重试</Button>} /> : null}
        </section>
        {user && channel ? snapshot ? <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">仅保存在当前账号的本机浏览器；未修改字段跟随后台默认值。</p><Button type="text" icon={<RotateCcw className="size-4" />} onClick={() => useConfigStore.setState({ systemOverrides: {} })}>全部恢复系统默认</Button></div>{error ? <Alert type="warning" title="系统配置刷新失败，当前使用上次成功读取的配置" /> : null}<SystemPreferencesForm value={{ ...snapshot.data.defaults, ...overrides }} models={models} overrides={overrides} onChange={update} onReset={key => update(key, undefined)} /></div> : !error ? <Alert type="info" title={loading ? "正在加载系统渠道配置" : "系统渠道配置尚未加载"} /> : null : null}
    </>;
}
