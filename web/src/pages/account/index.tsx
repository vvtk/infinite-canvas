import { useEffect, useState } from "react";
import { ArrowUpRight, UserRound } from "lucide-react";
import { Avatar, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { AccountOverviewStats } from "@/components/account/account-overview";
import { fetchAccountOverview, type AccountOverview } from "@/services/api/account";
import { useUserStore } from "@/stores/use-user-store";

export default function AccountPage() {
    const { t } = useTranslation();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);
    const [overview, setOverview] = useState<AccountOverview | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        void fetchAccountOverview()
            .then((result) => {
                setOverview(result);
                setUser({ ...result.user, id: user?.id || result.user.id });
            })
            .catch((reason: Error) => setError(reason.message));
    }, [setUser, user?.id]);
    if (!user) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("account.loginRequired")}</div>;
    return (
        <main className="h-full overflow-auto px-6 py-10">
            <div className="mx-auto max-w-3xl space-y-6">
                <div>
                    <p className="text-sm text-muted-foreground">{t("account.title")}</p>
                    <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("account.welcome", { name: user.displayName || user.username })}</h1>
                </div>
                <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                    <div className="flex items-center gap-3">
                        <Avatar size={48} src={user.avatarUrl || undefined} icon={<UserRound className="size-5" />} />
                        <div className="min-w-0">
                            <div className="truncate font-medium">{user.displayName || user.username}</div>
                            <div className="text-sm text-muted-foreground">ID: {user.displayId || user.id}</div>
                        </div>
                    </div>
                </section>
                {overview ? (
                    <AccountOverviewStats overview={overview} onRecharge={() => window.open(overview.links.rechargeUrl, "_blank", "noopener,noreferrer")} />
                ) : error ? (
                    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>
                ) : (
                    <div className="flex justify-center py-10">
                        <Spin />
                    </div>
                )}
                {overview ? (
                    <a className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" href={overview.links.rechargeUrl} target="_blank" rel="noreferrer">
                        {t("account.openWallet")} <ArrowUpRight className="size-4" />
                    </a>
                ) : null}
            </div>
        </main>
    );
}
