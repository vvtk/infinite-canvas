import { accountStorage } from "@/lib/account-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { LibraryData } from "@/services/api/admin";
import { nanoid } from "nanoid";
import { collectImageStorageKeys } from "@/services/image-storage";
import { collectMediaStorageKeys } from "@/services/file-storage";

export type WorkflowDraft = {
    tutorialId?: string; revision?: number; data: Omit<LibraryData, "workflow" | "workflowSummary">; published: boolean; position: number;
    project: CanvasProject; dirty: boolean;
};
export const workflowDrafts = accountStorage({ name: "infinite-canvas", storeName: "workflow_drafts" });
export function emptyWorkflowDraft(data: Partial<WorkflowDraft["data"]> = {}): WorkflowDraft {
    const now = new Date().toISOString();
    return { data: { title: "", description: "", coverUrl: "", tags: [], category: "", ...data, format: "workflow" }, published: false, position: 0, dirty: false, project: { id: `workflow-draft:${nanoid()}`, title: data.title || "新教程流程", createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
}
export function mergeSavedWorkflowDraft(before: WorkflowDraft, latest: WorkflowDraft, saved: WorkflowDraft): WorkflowDraft {
    return {
        ...latest, tutorialId: saved.tutorialId, revision: saved.revision,
        data: latest.data === before.data ? saved.data : latest.data,
        published: latest.published === before.published ? saved.published : latest.published,
        position: latest.position === before.position ? saved.position : latest.position,
        dirty: latest.project !== before.project || latest.data !== before.data || latest.published !== before.published || latest.position !== before.position,
    };
}
export function workflowDraftWriter(key: string) {
    const sourceKey = key;
    let latest: WorkflowDraft | null = null;
    let pending: WorkflowDraft | null = null;
    let writing: Promise<void> | null = null;
    const write = (draft: WorkflowDraft) => {
        latest = draft;
        pending = draft;
        writing ||= (async () => {
            try { while (pending) { const next = pending; pending = null; await workflowDrafts.setItem(key, next); } }
            finally { writing = null; }
        })();
        return writing;
    };
    return Object.assign(write, { archive: async (nextKey: string) => {
        if (!latest) return;
        await write(latest);
        if (key !== nextKey) { key = nextKey; await write(latest); }
        if (sourceKey !== nextKey) await workflowDrafts.removeItem(sourceKey);
    } });
}
const retained = new Set<unknown>();
export function retainWorkflowMedia(value: unknown) {
    retained.add(value);
    return () => { retained.delete(value); };
}
export function isWorkflowMediaRetained(key: string) {
    const collect = key.startsWith("image:") ? collectImageStorageKeys : collectMediaStorageKeys;
    return [...retained].some(value => collect(value).has(key));
}
export async function workflowMediaRetention() {
    const drafts: unknown[] = [...retained];
    await workflowDrafts.iterate<WorkflowDraft, void>(draft => { drafts.push(draft.project); });
    return drafts;
}
