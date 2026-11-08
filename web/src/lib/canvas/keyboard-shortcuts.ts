export const canvasShortcutActions = ["selectAll", "copy", "paste", "group", "ungroup", "undo", "redo", "delete", "escape"] as const;

export type CanvasShortcutAction = (typeof canvasShortcutActions)[number];
export type CanvasShortcutBindings = Record<CanvasShortcutAction, string[]>;

export const defaultCanvasShortcutBindings: CanvasShortcutBindings = {
    selectAll: ["mod+a"],
    copy: ["mod+c"],
    paste: ["mod+v"],
    group: ["mod+g"],
    ungroup: ["mod+shift+g"],
    undo: ["mod+z"],
    redo: ["mod+shift+z", "mod+y"],
    delete: ["Delete", "Backspace"],
    escape: ["Escape"],
};

function normalizedKey(key: string) {
    if (key === " ") return "Space";
    if (key.length === 1) return key.toLowerCase();
    return key;
}

export function shortcutFromEvent(event: KeyboardEvent) {
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null;
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push("mod");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    parts.push(normalizedKey(event.key));
    return parts.join("+");
}

export function matchesCanvasShortcut(event: KeyboardEvent, shortcut: string) {
    return shortcutFromEvent(event) === shortcut;
}

export function displayCanvasShortcut(shortcut: string, isMac = /Mac|iPhone|iPad/.test(navigator.platform)) {
    return shortcut.split("+").map((part) => part === "mod" ? (isMac ? "⌘" : "Ctrl") : part === "shift" ? (isMac ? "⇧" : "Shift") : part === "alt" ? (isMac ? "⌥" : "Alt") : part.length === 1 ? part.toUpperCase() : part).join("+");
}

export function canvasShortcutLabel(bindings: CanvasShortcutBindings, action: CanvasShortcutAction) {
    return bindings[action].map((shortcut) => displayCanvasShortcut(shortcut)).join(" / ");
}
