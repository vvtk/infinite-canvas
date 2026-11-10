import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { App, Avatar, Button, Dropdown, Modal, Spin } from "antd";
import { ArrowUpRight, LogOut, RefreshCw, Settings2, ShieldCheck, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AccountOverviewStats } from "@/components/account/account-overview";
import { fetchAccountOverview, type AccountOverview } from "@/services/api/account";
import { clearAccountCredential, hasGuestData, importGuestData, setupAccountChannel } from "@/services/account";
import { cloudRequest } from "@/services/api/cloud";
import { cloudMeta } from "@/services/cloud-data";
import { startCloudSync, stopCloudSync, syncNow } from "@/services/cloud-sync";
import { localForageStorage } from "@/lib/localforage-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCloudStore } from "@/stores/use-cloud-store";
import { useUserStore } from "@/stores/use-user-store";

let initializedAccount = "";

function AccountActionRow({ icon, children, onClick, danger = false }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
    return (
        <button type="button" className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-black/5 dark:hover:bg-white/10 ${danger ? "text-destructive" : "text-foreground"}`} onClick={onClick}>
            {icon}
            <span>{children}</span>
        </button>
    );
}

export function AccountActions({ style }: { style?: CSSProperties }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);
    const status = useCloudStore((state) => state.status);
    const error = useCloudStore((state) => state.error);
    const conflicts = useCloudStore((state) => state.conflicts);
    const [busy, setBusy] = useState(false);
    const [loginDialogOpen, setLoginDialogOpen] = useState(false);
    const [open, setOpen] = useState(false);
    const [overview, setOverview] = useState<AccountOverview | null>(null);
    const [overviewError, setOverviewError] = useState("");
    const { message, modal } = App.useApp();

    useEffect(() => {
        const url = new URL(window.location.href);
        if (!url.searchParams.has("auth_error")) return;
        url.searchParams.delete("auth_error");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        void message.error(t("account.loginFailed"));
    }, [message, t]);

    useEffect(() => {
        if (!user || initializedAccount === user.id) return;
        initializedAccount = user.id;
        startCloudSync();
        void setupAccountChannel().catch((reason: Error) => {
            void message.warning(reason.message);
        });
        void hasGuestData()
            .then((exists) => {
                if (!exists) return;
                modal.confirm({
                    title: t("account.importTitle"),
                    content: t("account.importDescription"),
                    okText: t("account.importConfirm"),
                    cancelText: t("account.importCancel"),
                    onOk: async () => {
                        await importGuestData();
                        await syncNow();
                    },
                    onCancel: async () => {
                        await cloudMeta.setItem("guest-import-decided", true);
                    },
                });
            })
            .catch((reason: Error) => {
                void message.error(reason.message);
            });
    }, [message, modal, t, user]);

    useEffect(() => {
        if (!open || !user) return;
        setOverview((current) => current?.user.id === user.id ? current : null);
        setOverviewError("");
        void fetchAccountOverview()
            .then((result) => {
                setOverview(result);
                setUser({ ...result.user, id: user.id });
            })
            .catch((reason: Error) => {
                setOverview(null);
                setOverviewError(reason.message);
            });
    }, [open, setUser, user?.id]);

    const login = () => {
        const authUrl = `/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        setLoginDialogOpen(false);
        window.location.assign(authUrl);
    };
    async function logout() {
        setBusy(true);
        try {
            await stopCloudSync();
            const { projects, deletedProjects } = useCanvasStore.getState();
            await localForageStorage.setItem("infinite-canvas:canvas_store", JSON.stringify({ state: { projects, deletedProjects }, version: 0 }));
            await clearAccountCredential();
            await cloudRequest("/auth/logout", {}, "POST", null);
            localStorage.removeItem("canvas:last-account");
            window.location.assign("/");
        } catch (reason) {
            void message.error((reason as Error).message);
            setBusy(false);
        }
    }
    const closeAnd = (action: () => void) => {
        setOpen(false);
        action();
    };
    const labels = { local: t("account.syncLocal"), pending: t("account.syncPending"), syncing: t("account.syncing"), synced: t("account.synced"), error: t("account.syncError") };
    const className = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50";
    if (!user)
        return (
            <>
                <button type="button" className={className} style={style} onClick={() => setLoginDialogOpen(true)}>
                    <span>{t("account.login")}</span>
                </button>
                <Modal open={loginDialogOpen} onCancel={() => setLoginDialogOpen(false)} footer={null} centered width={360} title={null}>
                    <div className="flex flex-col items-center gap-7 px-3 py-8">
                        <img src="/llmroam-logo.png" alt="LLMRoam" className="size-20 object-contain" />
                        <Button type="primary" block onClick={login}>
                            {t("account.authorizeLogin")}
                        </Button>
                    </div>
                </Modal>
            </>
        );
    return (
        <Dropdown
            trigger={["click"]}
            open={open}
            onOpenChange={setOpen}
            popupRender={() => (
                <div className="w-[304px] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-2xl">
                    <div className="flex items-center gap-3 px-2 py-1.5">
                        <Avatar size={40} src={user.avatarUrl || undefined} icon={<UserRound className="size-5" />} />
                        <div className="min-w-0">
                            <div className="truncate font-semibold">{user.displayName || user.username}</div>
                            <div className="text-xs text-muted-foreground">ID: {user.displayId || user.id}</div>
                        </div>
                    </div>
                    <div className="my-3">
                        {overview ? (
                            <AccountOverviewStats overview={overview} compact onRecharge={() => window.open(overview.links.rechargeUrl, "_blank", "noopener,noreferrer")} />
                        ) : overviewError ? (
                            <div className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">{overviewError}</div>
                        ) : (
                            <div className="flex justify-center rounded-xl bg-muted py-8">
                                <Spin size="small" />
                            </div>
                        )}
                    </div>
                    <div className="space-y-0.5 border-t border-border pt-2">
                        <AccountActionRow icon={<UserRound className="size-4" />} onClick={() => closeAnd(() => navigate("/account"))}>
                            {t("account.personalCenter")}
                        </AccountActionRow>
                        {overview?.user.isAdmin ? (
                            <AccountActionRow icon={<ShieldCheck className="size-4" />} onClick={() => closeAnd(() => navigate("/admin"))}>
                                {t("account.adminCenter")}
                            </AccountActionRow>
                        ) : null}
                        <AccountActionRow
                            icon={<RefreshCw className="size-4" />}
                            onClick={() =>
                                closeAnd(() => {
                                    void syncNow();
                                })
                            }
                        >
                            {error || `${t("account.cloudSync")}: ${labels[status]}`}
                            {conflicts ? ` · ${t("account.conflicts", { count: conflicts })}` : ""}
                        </AccountActionRow>
                        <AccountActionRow
                            icon={<Settings2 className="size-4" />}
                            onClick={() =>
                                closeAnd(() =>
                                    modal.confirm({
                                        title: t("account.revokeTitle"),
                                        content: t("account.revokeDescription"),
                                        okText: t("account.revokeConfirm"),
                                        cancelText: t("common.cancel"),
                                        onOk: async () => {
                                            await cloudRequest("/auth/revoke-credentials", {});
                                            await clearAccountCredential();
                                            void message.success(t("account.revokeSuccess"));
                                        },
                                    }),
                                )
                            }
                        >
                            {t("account.revokeCredentials")}
                        </AccountActionRow>
                        <div className="my-1 border-t border-border" />
                        <AccountActionRow
                            icon={<LogOut className="size-4" />}
                            danger
                            onClick={() =>
                                closeAnd(() => {
                                    void logout();
                                })
                            }
                        >
                            {t("account.logout")}
                        </AccountActionRow>
                    </div>
                    {overview ? (
                        <a href={overview.links.rechargeUrl} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-end gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
                            {t("account.openWallet")} <ArrowUpRight className="size-3.5" />
                        </a>
                    ) : null}
                </div>
            )}
        >
            <button type="button" className={className} style={style} disabled={busy} aria-label={t("account.menuLabel")} aria-expanded={open} title={error || labels[status]}>
                <Avatar size={22} src={user.avatarUrl || undefined} icon={<UserRound className="size-3.5" />} />
                <span className="hidden max-w-24 truncate sm:inline">{user.displayName || user.username}</span>
                <span className={`size-1.5 rounded-full ${status === "error" ? "bg-red-500" : status === "synced" ? "bg-emerald-500" : "bg-amber-500"}`} />
            </button>
        </Dropdown>
    );
}
