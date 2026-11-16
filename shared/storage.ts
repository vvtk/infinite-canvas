export type StorageProvider = "s3" | "oss";
export type StoragePool = {
    id: string; name: string; provider: StorageProvider; endpoint: string; publicEndpoint: string;
    region: string; bucket: string; prefix: string; pathStyle: boolean; writable: boolean; capacityBytes: number | null;
    hasCredentials: boolean; revision: number; mediaCount: number; usedBytes: number; backupBytes: number;
};
export type StoragePoolInput = Pick<StoragePool, "name" | "provider" | "endpoint" | "publicEndpoint" | "region" | "bucket" | "prefix" | "pathStyle" | "writable" | "capacityBytes"> & { accessKey: string; secretKey: string; revision?: number };
export type StoragePolicy = { mode: "single" | "round-robin"; defaultPoolId: string | null; revision: number };
export type StorageTaskKind = "migration" | "backup" | "restore" | "cleanup" | "delete-backup";
export type StorageTask = {
    id: string; kind: StorageTaskKind; sourcePoolId: string | null; targetPoolId: string | null;
    backupId: string | null; status: "pending" | "running" | "failed" | "completed"; error: string;
    total: number; completed: number; bytes: number; completedBytes: number; createdAt: string; updatedAt: string;
};
export type StorageBackup = { id: string; sourcePoolId: string; targetPoolId: string; status: "building" | "ready" | "deleting" | "deleted"; bytes: number; mediaCount: number; recordCount: number; createdAt: string };
export type RestoreEntry = { key: string; label: string; kind: "record" | "library" | "logo"; state: "missing" | "conflict"; revision: number | null; userId?: string };
export type RestorePreview = { id: string; backupId: string; entries: RestoreEntry[]; usage: Array<{ userId: string; username: string; usedBytes: number; quotaBytes: number; estimatedAddedBytes: number }> };
