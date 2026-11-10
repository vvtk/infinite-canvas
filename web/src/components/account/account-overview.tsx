import { useTranslation } from "react-i18next";
import type { AccountOverview } from "@/services/api/account";

export function formatStorageSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0K";
    const kilobytes = bytes / 1024;
    if (kilobytes < 1024) return `${Math.round(kilobytes)}K`;
    const megabytes = kilobytes / 1024;
    if (megabytes < 1024) return `${megabytes.toFixed(1)}M`;
    return `${(megabytes / 1024).toFixed(1)}G`;
}

export function AccountOverviewStats({ overview, compact = false, onRecharge }: { overview: AccountOverview; compact?: boolean; onRecharge?: () => void }) {
    const { t } = useTranslation();
    const used = Math.max(0, overview.storage.usedBytes);
    const quota = Math.max(0, overview.storage.quotaBytes);
    const percent = quota ? Math.min(100, (used / quota) * 100) : 0;
    return (
        <div className={compact ? "space-y-2" : "grid gap-4 sm:grid-cols-2"}>
            <section className="rounded-xl bg-muted p-3">
                <div className="text-xs text-muted-foreground">{t("account.pointsBalance")}</div>
                <div className="mt-1 flex items-end justify-between gap-3">
                    <strong className="text-2xl font-semibold tabular-nums">{overview.user.points.toLocaleString(undefined, { maximumFractionDigits: Math.abs(overview.user.points) >= 1 ? 2 : 4 })}</strong>
                    {onRecharge ? (
                        <button type="button" className="text-sm font-medium text-foreground underline-offset-4 hover:underline" onClick={onRecharge}>
                            {t("account.recharge")}
                        </button>
                    ) : null}
                </div>
            </section>
            <section className="rounded-xl bg-muted p-3">
                <div className="text-xs text-muted-foreground">{t("account.storage")}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                    {formatStorageSize(used)} / {formatStorageSize(quota)}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                    <div className="h-full rounded-full bg-foreground/70 transition-[width]" style={{ width: `${percent}%` }} />
                </div>
            </section>
        </div>
    );
}
