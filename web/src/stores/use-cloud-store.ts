import { create } from "zustand";
export type SyncStatus = "local" | "pending" | "syncing" | "synced" | "error";
export const useCloudStore = create<{ status: SyncStatus; error: string; conflicts: number }>()(() => ({ status: "local", error: "", conflicts: 0 }));
