import { create } from "zustand";
import { persist } from "zustand/middleware";

import { canvasShortcutActions, defaultCanvasShortcutBindings, type CanvasShortcutAction, type CanvasShortcutBindings } from "@/lib/canvas/keyboard-shortcuts";

type CanvasShortcutStore = {
    bindings: CanvasShortcutBindings;
    setBinding: (action: CanvasShortcutAction, shortcut: string) => boolean;
    resetBindings: () => void;
};

export const useCanvasShortcutStore = create<CanvasShortcutStore>()(
    persist(
        (set, get) => ({
            bindings: defaultCanvasShortcutBindings,
            setBinding: (action, shortcut) => {
                const bindings = get().bindings;
                if (canvasShortcutActions.some((otherAction) => otherAction !== action && bindings[otherAction].includes(shortcut))) return false;
                set({ bindings: { ...bindings, [action]: [shortcut] } });
                return true;
            },
            resetBindings: () => set({ bindings: defaultCanvasShortcutBindings }),
        }),
        {
            name: "infinite-canvas:keyboard_shortcuts",
            partialize: (state) => ({ bindings: state.bindings }),
        },
    ),
);
