import { create } from "zustand";
import { getInitialSession } from "@/lib/account-storage";

export type LocalUser = {
    id: string;
    displayId?: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role?: number;
    points?: number;
    usedPoints?: number;
    isAdmin?: boolean;
};

type UserStore = {
    user: LocalUser | null;
    setUser: (user: LocalUser) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: getInitialSession().user,
    setUser: (user) => set({ user }),
    clearSession: () => set({ user: null }),
}));
