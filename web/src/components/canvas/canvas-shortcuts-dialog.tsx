import { useEffect, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";
import { App, Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { canvasShortcutActions, canvasShortcutLabel, shortcutFromEvent, type CanvasShortcutAction } from "@/lib/canvas/keyboard-shortcuts";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasShortcutStore } from "@/stores/canvas/use-canvas-shortcut-store";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const bindings = useCanvasShortcutStore((state) => state.bindings);
    const setBinding = useCanvasShortcutStore((state) => state.setBinding);
    const resetBindings = useCanvasShortcutStore((state) => state.resetBindings);
    const [recording, setRecording] = useState<CanvasShortcutAction | null>(null);

    useEffect(() => {
        if (!open || !recording) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const shortcut = shortcutFromEvent(event);
            if (!shortcut) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (setBinding(recording, shortcut)) setRecording(null);
            else {
                message.warning(t("canvas.shortcutConflict"));
                setRecording(null);
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [message, open, recording, setBinding, t]);

    useEffect(() => {
        if (!open) setRecording(null);
    }, [open]);

    return (
        <Modal title={t("canvas.shortcuts")} open={open} onCancel={onClose} footer={null} centered>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                <div className="flex justify-end">
                    <Button type="text" icon={<RotateCcw className="size-4" />} onClick={() => { resetBindings(); setRecording(null); }}>
                        {t("canvas.resetShortcuts")}
                    </Button>
                </div>
                <div className="space-y-1">
                    {canvasShortcutActions.map((action) => (
                        <div key={action} className="flex min-h-11 items-center justify-between gap-3 px-1">
                            <span className="min-w-0">{t(`canvas.shortcutActions.${action}`)}</span>
                            <Button
                                type={recording === action ? "primary" : "text"}
                                icon={<Keyboard className="size-4" />}
                                onClick={() => setRecording((current) => current === action ? null : action)}
                                aria-label={t("canvas.recordShortcut", { action: t(`canvas.shortcutActions.${action}`) })}
                            >
                                {recording === action ? t("canvas.pressShortcut") : canvasShortcutLabel(bindings, action)}
                            </Button>
                        </div>
                    ))}
                </div>
                <div className="space-y-1 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="px-1 pb-1 font-medium">{t("canvas.fixedGestures")}</div>
                    <Gesture label={`Ctrl / Space + ${t("canvas.shortcut.drag")}`} value={t("canvas.shortcut.toggleTool")} />
                    <Gesture label={t("canvas.shortcut.wheel")} value={t("canvas.shortcut.zoom")} />
                    <Gesture label={t("canvas.shortcut.zoomSlider")} value={t("canvas.shortcut.preciseZoom")} />
                    <Gesture label={t("canvas.shortcut.drag")} value={t("canvas.shortcut.boxSelect")} />
                    <Gesture label={`Shift / Cmd + ${t("canvas.shortcut.click")}`} value={t("canvas.shortcut.addSelection")} />
                    <Gesture label={t("canvas.shortcut.dropMedia")} value={t("canvas.shortcut.upload")} />
                    <Gesture label={t("canvas.shortcut.rightClickCanvas")} value={t("canvas.shortcut.openNodePicker")} />
                </div>
                <p className="px-1 text-xs opacity-55">{t("canvas.shortcutConflictHint")}</p>
            </div>
        </Modal>
    );
}

function Gesture({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-h-11 items-center justify-between gap-3 px-1">
            <span className="min-w-0">{value}</span>
            <Button type="text" disabled icon={<Keyboard className="size-4" />} tabIndex={-1} aria-hidden="true">
                {label}
            </Button>
        </div>
    );
}
