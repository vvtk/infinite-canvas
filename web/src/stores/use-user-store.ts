import { create } from "zustand";
import { getInitialSession } from "@/lib/account-storage";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
};

type UserStore = {
    user: LocalUser | null;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: getInitialSession().user,
    clearSession: () => set({ user: null }),
}));
