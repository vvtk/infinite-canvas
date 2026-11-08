import { useEffect, useState, type CSSProperties } from "react";
import { App, Avatar, Dropdown } from "antd";
import { Cloud, LogIn, UserRound } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { useCloudStore } from "@/stores/use-cloud-store";
import { cloudRequest } from "@/services/api/cloud";
import { setupAccountChannel, clearAccountCredential, hasGuestData, importGuestData } from "@/services/account";
import { startCloudSync, stopCloudSync, syncNow } from "@/services/cloud-sync";
import { cloudMeta } from "@/services/cloud-data";
import { localForageStorage } from "@/lib/localforage-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

let initialized = false;
export function AccountActions({ style }: { style?: CSSProperties }) {
    const user = useUserStore((state) => state.user);
    const status = useCloudStore((state) => state.status);
    const error = useCloudStore((state) => state.error);
    const conflicts = useCloudStore((state) => state.conflicts);
    const [busy, setBusy] = useState(false);
    const { message, modal } = App.useApp();
    const login = () => { window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); };
    useEffect(() => {
        if (!user || initialized) return;
        initialized = true;
        startCloudSync();
        void setupAccountChannel().catch((error: Error) => { void message.warning(error.message); });
        void hasGuestData().then((exists) => {
            if (!exists) return;
            modal.confirm({ title: "导入已有本地数据？", content: "导入后会将此浏览器的访客画布、素材和生成历史同步到当前账号。API Key 和本地 Agent 配置不会导入。", okText: "导入并同步", cancelText: "保留在访客空间", onOk: async () => { await importGuestData(); await syncNow(); }, onCancel: async () => { await cloudMeta.setItem("guest-import-decided", true); } });
        }).catch((error: Error) => { void message.error(error.message); });
    }, [user, message, modal]);
    async function logout() {
        setBusy(true);
        try {
            await stopCloudSync();
            // Flush the canvas's delayed local write before leaving its account namespace.
            const { projects, deletedProjects } = useCanvasStore.getState();
            await localForageStorage.setItem("infinite-canvas:canvas_store", JSON.stringify({ state: { projects, deletedProjects }, version: 0 }));
            await clearAccountCredential();
            await cloudRequest("/auth/logout", {}, "POST", null);
            localStorage.removeItem("canvas:last-account");
            window.location.assign("/");
        } catch (error) { void message.error((error as Error).message); setBusy(false); }
    }
    const className = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50";
    if (!user) return <button type="button" className={className} style={style} onClick={login}><LogIn className="size-4" /><span>登录</span></button>;
    const labels = { local: "本地保存", pending: "待同步", syncing: "正在同步", synced: "已同步", error: "同步失败" };
    return (
        <Dropdown trigger={["click"]} menu={{ items: [
            { key: "status", disabled: true, label: error || labels[status], icon: <Cloud className="size-4" /> },
            ...(conflicts ? [{ key: "conflicts", disabled: true, label: `已保留 ${conflicts} 个冲突副本` }] : []),
            { key: "sync", label: "立即同步", disabled: busy || status === "syncing", onClick: () => { void syncNow(); } },
            { key: "revoke", label: "撤销专用 API 凭据", danger: true, onClick: () => modal.confirm({ title: "撤销专用 API 凭据？", content: "撤销后停止使用该凭据调用模型。再次授权后可以创建新凭据。", okText: "撤销", cancelText: "取消", onOk: async () => { await cloudRequest("/auth/revoke-credentials", {}); await clearAccountCredential(); void message.success("专用 API 凭据已撤销"); } }) },
            { type: "divider" },
            { key: "logout", label: "退出登录", disabled: busy, onClick: () => { void logout(); } },
        ] }}>
            <button type="button" className={className} style={style} disabled={busy} aria-label="账号菜单" title={error || labels[status]}>
                <Avatar size={22} src={user.avatarUrl || undefined} icon={<UserRound className="size-3.5" />} />
                <span className="hidden max-w-24 truncate sm:inline">{user.displayName || user.username}</span>
                <span className={`size-1.5 rounded-full ${status === "error" ? "bg-red-500" : status === "synced" ? "bg-emerald-500" : "bg-amber-500"}`} />
            </button>
        </Dropdown>
    );
}
