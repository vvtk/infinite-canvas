import { useState, type ReactNode } from "react";
import { Popconfirm, Spin } from "antd";
import { ChevronRight, FileText, Image as ImageIcon, Plus, Trash2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AssetKind } from "@/stores/use-asset-store";

export const ASSET_GROUPS = [
    { kind: "image", icon: ImageIcon },
    { kind: "video", icon: Video },
    { kind: "text", icon: FileText },
] as const;

type AssetPreview = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    data: { content?: string; url?: string; dataUrl?: string };
};

export function CanvasAssetGroup({ kind, count, children }: { kind: AssetKind; count: number; children: ReactNode }) {
    const { t } = useTranslation();
    const [collapsed, setCollapsed] = useState(false);
    const Icon = ASSET_GROUPS.find(group => group.kind === kind)!.icon;
    return <div>
        <button type="button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100">
            <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
            <Icon className="size-3.5" />
            <span>{t(`assets.kinds.${kind}`)}</span>
            <span className="opacity-50">{count}</span>
        </button>
        {collapsed ? null : <div className="grid grid-cols-2 gap-2 px-1 pb-2 pt-1">{children}</div>}
    </div>;
}

export function CanvasAssetCard({ asset, theme, onInsert, onRemove, disabled, loading, insertLabel }: {
    asset: AssetPreview;
    theme: CanvasTheme;
    onInsert: () => void;
    onRemove?: () => void;
    disabled?: boolean;
    loading?: boolean;
    insertLabel?: string;
}) {
    const { t } = useTranslation();
    const label = insertLabel || t("canvas.sidePanel.inserted");
    const mediaClass = "size-full object-cover transition duration-300 group-hover:scale-[1.04]";
    return <div title={asset.title} className="group relative aspect-square overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 hover:shadow-lg" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
        {asset.kind === "text" ? <div className="size-full overflow-hidden whitespace-pre-wrap break-words p-2.5 text-[11px] leading-snug opacity-80">{asset.data.content}</div> : asset.kind === "video" && !asset.coverUrl ? <video src={`${asset.data.url}#t=0.1`} muted playsInline preload="metadata" className={mediaClass} /> : <img src={asset.coverUrl || asset.data.dataUrl} alt={asset.title} className={mediaClass} />}
        <div className={cn("absolute inset-0 flex items-center justify-center gap-2.5 opacity-0 transition duration-200 group-hover:opacity-100 group-focus-within:opacity-100", loading && "opacity-100")}>
            <button type="button" onClick={onInsert} disabled={disabled} title={label} aria-label={label} className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80">
                {loading ? <Spin size="small" /> : <Plus className="size-4" />}
            </button>
            {onRemove ? <Popconfirm title={t("canvas.sidePanel.removeAssetTitle")} okText={t("canvas.sidePanel.remove")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} onConfirm={onRemove}>
                <button type="button" className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-red-500 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80 dark:hover:text-red-400" aria-label={t("canvas.sidePanel.removeAsset")}>
                    <Trash2 className="size-4" />
                </button>
            </Popconfirm> : null}
        </div>
    </div>;
}
