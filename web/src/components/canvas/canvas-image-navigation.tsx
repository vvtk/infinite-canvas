import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasImageNavigation({ index, count, onChange, className = "" }: { index: number; count: number; onChange: (direction: -1 | 1) => void; className?: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (count < 2) return null;

    return (
        <div
            className={`flex w-max items-center gap-1 ${className}`}
            style={{ color: theme.node.text, textShadow: `0 0 4px ${theme.canvas.background}` }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <button type="button" className="grid size-8 place-items-center rounded-md bg-transparent transition hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("canvas.imageNavigation.previous")} title={`${t("canvas.imageNavigation.previous")} (← / A)`} onClick={() => onChange(-1)}>
                <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-10 text-center text-xs tabular-nums" aria-live="polite" aria-atomic="true">{index < 0 ? "—" : index + 1} / {count}</span>
            <button type="button" className="grid size-8 place-items-center rounded-md bg-transparent transition hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("canvas.imageNavigation.next")} title={`${t("canvas.imageNavigation.next")} (→ / D)`} onClick={() => onChange(1)}>
                <ChevronRight className="size-4" />
            </button>
        </div>
    );
}
