import localforage from "localforage";

export type AccountSession = { user: { id: string; displayId?: string; username: string; displayName: string; avatarUrl: string; role?: number; points?: number; usedPoints?: number; isAdmin?: boolean } | null };
let account = "guest";
let initialSession: AccountSession = { user: null };
export function initializeAccount(session: AccountSession, offlineAccount = "guest") {
    initialSession = session;
    account = session.user?.id || offlineAccount;
}
export const getAccount = () => account;
export const getInitialSession = () => initialSession;
export function accountStorage(options: LocalForageOptions) {
    const store = localforage.createInstance({ ...options, name: account === "guest" ? options.name : `${options.name}:account:${account}` });
    if (!["app_state", "image_generation_logs", "video_generation_logs", "image_files", "media_files"].includes(options.storeName || "")) return store;
    for (const method of ["setItem", "removeItem", "clear"] as const) {
        const original = store[method].bind(store);
        // Preserve localforage's generic overloads while observing successful writes.
        Object.defineProperty(store, method, { value: async (...args: unknown[]) => {
            const result = await (original as (...values: unknown[]) => Promise<unknown>)(...args);
            window.dispatchEvent(new CustomEvent("canvas-local-save", { detail: options.storeName }));
            return result;
        } });
    }
    return store;
}
