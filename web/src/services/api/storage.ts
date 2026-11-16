import { adminRequest } from "./admin";
import type { StoragePool, StoragePoolInput, StoragePolicy, StorageTask, StorageBackup, RestorePreview } from "../../../../shared/storage";
export type { StoragePool, StoragePoolInput, StoragePolicy, StorageTask, StorageBackup, RestorePreview, RestoreEntry } from "../../../../shared/storage";

export const fetchStoragePools = () => adminRequest<{ items: StoragePool[]; policy: StoragePolicy }>("/storage/pools");
export const fetchStorageTasks = () => adminRequest<{ items: StorageTask[] }>("/storage/tasks");
export const fetchStorageBackups = () => adminRequest<{ items: StorageBackup[] }>("/storage/backups");
export const fetchStorageTaskItems = (id: string) => adminRequest<{ items: Array<{ id: string; kind: string; mediaId: string; bytes: number; status: string; retireAfter: string | null }> }>(`/storage/tasks/${encodeURIComponent(id)}`);
export const saveStoragePool = (input: StoragePoolInput, id?: string) => adminRequest(id ? `/storage/pools/${encodeURIComponent(id)}` : "/storage/pools", input, id ? "PATCH" : "POST");
export const deleteStoragePool = (id: string) => adminRequest(`/storage/pools/${encodeURIComponent(id)}`, undefined, "DELETE");
export const testStoragePool = (id: string) => adminRequest<{ message: string }>(`/storage/pools/${encodeURIComponent(id)}/test`, {});
export const saveStoragePolicy = (policy: StoragePolicy) => adminRequest("/storage/policy", policy, "PATCH");
export type StorageTaskInput = { kind: "migration" | "backup"; sourcePoolId: string; targetPoolId: string } | { kind: "cleanup"; migrationTaskId: string } | { kind: "restore"; backupId: string; previewId: string; targetPoolId: string; selected: string[] };
export const createStorageTask = (input: StorageTaskInput) => adminRequest<{ id: string }>("/storage/tasks", input);
export const continueStorageTask = (id: string) => adminRequest(`/storage/tasks/${encodeURIComponent(id)}/continue`, {});
export const previewStorageRestore = (id: string) => adminRequest<RestorePreview>(`/storage/backups/${encodeURIComponent(id)}/preview`, {});
export const deleteStorageBackup = (id: string) => adminRequest(`/storage/backups/${encodeURIComponent(id)}`, undefined, "DELETE");
export const storagePoolInput = (pool: StoragePool): StoragePoolInput => ({ name: pool.name, provider: pool.provider, endpoint: pool.endpoint, publicEndpoint: pool.publicEndpoint, region: pool.region, bucket: pool.bucket, prefix: pool.prefix, pathStyle: pool.pathStyle, writable: pool.writable, capacityBytes: pool.capacityBytes, accessKey: "", secretKey: "", revision: pool.revision });
export const storageBytes = (value: number) => {
    if (!value) return "0 B";
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
    return `${(value / 1024 ** unit).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
};
