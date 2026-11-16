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
    authorizationId?: number;
};

type UserStore = {
    user: LocalUser | null;
    loginDialogOpen: boolean;
    setLoginDialogOpen: (open: boolean) => void;
    setUser: (user: LocalUser) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: getInitialSession().user,
    loginDialogOpen: false,
    setLoginDialogOpen: (loginDialogOpen) => set({ loginDialogOpen }),
    setUser: (user) => set(state => ({ user: state.user?.id === user.id ? { ...state.user, ...user } : user })),
    clearSession: () => set({ user: null }),
}));
