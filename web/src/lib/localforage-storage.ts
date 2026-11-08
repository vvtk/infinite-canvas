import { accountStorage, getAccount } from "@/lib/account-storage";
import type { StateStorage } from "zustand/middleware";

const localforage = accountStorage({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || (getAccount() === "guest" ? window.localStorage.getItem(name) : null);
        } catch {
            return window.localStorage.getItem(`${getAccount()}:${name}`);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            // Business data must not silently fall back to unscoped localStorage.
            throw new Error("本地存储不可用，请检查浏览器存储权限");
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(`${getAccount()}:${name}`);
        }
    },
};
