import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useBeforeUnload, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Spin, Switch, Upload } from "antd";
import { ArrowLeft, Save, Settings2, Workflow } from "lucide-react";
import { CanvasEditor, type CanvasEditorSnapshot } from "@/pages/canvas/project";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasShortcutsDialog } from "@/components/canvas/canvas-shortcuts-dialog";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { adminRequest, fetchAdminTutorial, uploadPublicFile, type LibraryData } from "@/services/api/admin";
import { materializeWorkflow, publishWorkflow } from "@/services/api/tutorial-workflow";
import { CloudError } from "@/services/api/cloud";
import { emptyWorkflowDraft, mergeSavedWorkflowDraft, retainWorkflowMedia, workflowDrafts, workflowDraftWriter, type WorkflowDraft } from "@/services/workflow-drafts";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { workflowGraphError, type WorkflowMedia } from "../../../../shared/tutorial-workflow";

export default function CanvasWorkflowPage() {
    const { id } = useParams<{ id: string }>();
    const { pathname } = useLocation();
    const accountId = useUserStore(state => state.user?.id);
    const permission = useQuery({ queryKey: ["admin", "permission", accountId, pathname], queryFn: ({ signal }) => adminRequest<{ userId: string }>("/session", undefined, "GET", signal), retry: false, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true });
    if (permission.isPending || !permission.isFetchedAfterMount) return <div className="grid h-full place-items-center"><Spin /></div>;
    if (permission.error) {
        if (permission.error instanceof CloudError && [401, 403].includes(permission.error.status)) return <Navigate to="/" replace />;
        return <div className="p-5"><Alert type="error" showIcon title="教程流程编辑暂时不可用" description={permission.error.message} action={<Button onClick={() => void permission.refetch()}>重试</Button>} /></div>;
    }
    return <WorkflowSession key={`${accountId}:${id || "new"}`} id={id} accountId={accountId} />;
}

function WorkflowSession({ id, accountId }: { id?: string; accountId?: string }) {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const client = useQueryClient();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [form] = Form.useForm();
    const [draft, setDraft] = useState<WorkflowDraft | null>(null);
    const [initial, setInitial] = useState<CanvasProject | null>(null);
    const [fitOnLoad, setFitOnLoad] = useState(false);
    const [error, setError] = useState("");
    const [localError, setLocalError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [pluginsOpen, setPluginsOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [reload, setReload] = useState(0);
    const draftRef = useRef<WorkflowDraft | null>(null);
    const firstSnapshot = useRef(true);
    const media = useRef<WorkflowMedia[]>([]);
    const saveController = useRef<AbortController | null>(null);
    const coverController = useRef<AbortController | null>(null);
    const savingRef = useRef(false);
    const createdId = useRef<string | undefined>(undefined);
    const dirtyRef = useRef(false);
    const discarding = useRef(false);
    const allowNavigation = useRef(false);
    const keep = useRef<{ project: CanvasProject | null }>({ project: null });
    const writeDraft = useMemo(() => workflowDraftWriter(id || "new"), [id]);
    const lastWrite = useRef<Promise<unknown>>(Promise.resolve());
    const latestSnapshot = useRef<CanvasEditorSnapshot | null>(null);
    const store = useCallback((next: WorkflowDraft) => {
        if (discarding.current) return;
        draftRef.current = next;
        dirtyRef.current = next.dirty;
        keep.current.project = next.project;
        setDraft(next);
        lastWrite.current = writeDraft(next).then(() => setLocalError(""), () => setLocalError("流程草稿保存到本机失败，请保留当前页面并重试保存"));
    }, [writeDraft]);
    useEffect(() => {
        const release = retainWorkflowMedia(keep.current);
        return () => { saveController.current?.abort(); coverController.current?.abort(); void lastWrite.current.finally(release); };
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            setError(""); setDraft(null); setInitial(null); firstSnapshot.current = true;
            let prepared: Awaited<ReturnType<typeof materializeWorkflow>> | undefined;
            try {
                const cached = await workflowDrafts.getItem<WorkflowDraft>(id || "new");
                const tutorialId = id || cached?.tutorialId;
                const item = tutorialId ? await fetchAdminTutorial(tutorialId, controller.signal) : null;
                controller.signal.throwIfAborted();
                createdId.current = tutorialId;
                media.current = item?.data.workflow?.media || [];
                let next = cached?.dirty ? cached : emptyWorkflowDraft(item?.data);
                const stale = Boolean(cached?.dirty && item && cached.revision !== item.revision);
                setConflict(stale);
                setFitOnLoad(!cached?.dirty && !!item?.data.workflow);
                if (!cached?.dirty) {
                    if (item?.data.workflow) {
                        const flow = item.data.workflow;
                        const invalid = workflowGraphError(flow);
                        if (invalid) throw new Error(invalid);
                        const center = { x: (Math.min(...flow.nodes.map(node => node.position.x)) + Math.max(...flow.nodes.map(node => node.position.x + node.width))) / 2, y: (Math.min(...flow.nodes.map(node => node.position.y)) + Math.max(...flow.nodes.map(node => node.position.y + node.height))) / 2 };
                        prepared = await materializeWorkflow(flow, useConfigStore.getState().config, center, controller.signal);
                        next.project = { ...next.project, nodes: prepared.nodes, connections: prepared.connections };
                    }
                    const incoming = location.state as { workflowData?: Partial<LibraryData>; workflowPublished?: boolean; workflowPosition?: number } | null;
                    const { workflow: _flow, workflowSummary: _summary, ...data } = item?.data || next.data;
                    next = { ...next, tutorialId, revision: item?.revision, data: { ...next.data, ...data, ...incoming?.workflowData, format: "workflow" }, published: incoming?.workflowPublished ?? item?.published ?? false, position: incoming?.workflowPosition ?? item?.position ?? 0, dirty: Boolean(incoming?.workflowData) };
                    delete (next.data as LibraryData).workflow;
                    delete (next.data as LibraryData).workflowSummary;
                }
                controller.signal.throwIfAborted();
                keep.current.project = next.project;
                await writeDraft(next);
                prepared?.release();
                prepared = undefined;
                controller.signal.throwIfAborted();
                draftRef.current = next; dirtyRef.current = next.dirty;
                latestSnapshot.current = next.project;
                discarding.current = false;
                setDraft(next); setInitial(next.project);
                form.setFieldsValue({ ...next.data, published: next.published, position: next.position });
                if (location.state?.workflowData) navigate(location.pathname, { replace: true, state: null });
            } catch (reason) {
                if (prepared) await prepared.discard();
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "流程加载失败");
            }
        };
        void load();
        return () => controller.abort();
    }, [id, accountId, reload, form, writeDraft]);

    const blocker = useBlocker(({ currentLocation, nextLocation }) => !allowNavigation.current && (dirtyRef.current || savingRef.current) && currentLocation.pathname !== nextLocation.pathname);
    useEffect(() => {
        if (blocker.state !== "blocked") return;
        const dialog = modal.confirm({ title: "流程尚未完成保存", content: "本机草稿会保留，确定离开编辑器吗？", okText: "离开", cancelText: "继续编辑", onOk: () => blocker.proceed(), onCancel: () => blocker.reset() });
        return () => dialog.destroy();
    }, [blocker, modal]);
    useBeforeUnload(useCallback((event: BeforeUnloadEvent) => { if (dirtyRef.current || savingRef.current) { event.preventDefault(); event.returnValue = ""; } }, []));

    const onChange = useCallback((patch: Partial<CanvasEditorSnapshot>) => {
        const current = draftRef.current;
        if (!current) return;
        const changed = Object.entries(patch).some(([key, value]) => current.project[key as keyof CanvasEditorSnapshot] !== value);
        if (!changed) return;
        const initializing = firstSnapshot.current && "nodes" in patch;
        if ("nodes" in patch) firstSnapshot.current = false;
        latestSnapshot.current = { ...current.project, ...patch };
        store({ ...current, project: { ...current.project, ...patch }, dirty: current.dirty || !initializing });
    }, [store]);

    const save = useCallback(async (snapshot?: CanvasEditorSnapshot) => {
        if (savingRef.current) return;
        if (conflict) { message.warning("后台版本已变化，请先处理修订冲突"); return; }
        if (uploading) { message.warning("请等待封面上传完成"); return; }
        savingRef.current = true;
        const controller = new AbortController();
        saveController.current = controller;
        setSaving(true);
        try {
            const current = draftRef.current;
            if (!current) return;
            let values;
            try { values = await form.validateFields(); }
            catch { setSettingsOpen(true); message.warning("请完善教程信息"); return; }
            const project = { ...current.project, ...(snapshot || latestSnapshot.current) };
            const before = { ...current, project, dirty: true };
            store(before);
            await writeDraft(before);
            const workflow = await publishWorkflow(project.nodes, project.connections, useConfigStore.getState().config, media.current, controller.signal);
            controller.signal.throwIfAborted();
            if (useUserStore.getState().user?.id !== accountId) throw new Error("账号已切换，保存已取消");
            const { published, position, ...data } = values;
            const targetId = id || createdId.current;
            const result = await adminRequest<{ id?: string }>(targetId ? `/tutorials/${encodeURIComponent(targetId)}` : "/tutorials", { data: { ...before.data, ...data, format: "workflow", workflow }, published, position, ...(targetId ? { revision: before.revision } : {}) }, targetId ? "PATCH" : "POST", controller.signal);
            controller.signal.throwIfAborted();
            const savedId = targetId || result.id!;
            if (!id) createdId.current = savedId;
            const latest = draftRef.current!;
            const next = mergeSavedWorkflowDraft(before, latest, { ...before, tutorialId: savedId, data: { ...before.data, ...data, format: "workflow" }, published, position, revision: targetId ? before.revision! + 1 : 1 });
            media.current = workflow.media;
            store(next);
            await writeDraft.archive(savedId);
            await Promise.all([client.invalidateQueries({ queryKey: ["admin", "library", "tutorials"] }), client.invalidateQueries({ queryKey: ["library"] })]);
            await writeDraft(draftRef.current!);
            controller.signal.throwIfAborted();
            if (useUserStore.getState().user?.id !== accountId) throw new Error("账号已切换，保存已取消");
            if (dirtyRef.current) {
                message.success("当前版本已保存，另有新修改未保存，请再次保存");
                if (!id) {
                    allowNavigation.current = true;
                    navigate(`/canvas/workflow/${encodeURIComponent(savedId)}`, { replace: true });
                }
                return;
            }
            allowNavigation.current = true;
            message.success("教程流程已保存");
            navigate("/admin/tutorials", { replace: true });
        } catch (reason) {
            if (reason instanceof CloudError && reason.status === 409) setConflict(true);
            if (!controller.signal.aborted) {
                if (draftRef.current && !draftRef.current.dirty) store({ ...draftRef.current, dirty: true });
                message.error(reason instanceof Error ? reason.message : "流程保存失败，草稿已保留");
            }
        } finally { savingRef.current = false; setSaving(false); }
    }, [id, accountId, form, store, writeDraft, navigate, client, message, conflict, uploading]);

    const tutorialId = id || draft?.tutorialId;
    const document = useMemo(() => initial ? { initial, tutorialId, busy: saving, fitOnLoad, onChange, onSave: save } : undefined, [initial, tutorialId, saving, fitOnLoad, onChange, save]);
    const discardDraft = () => modal.confirm({
        title: "放弃本机草稿并重新读取后台版本？", content: "当前未保存的修改会被替换。", okButtonProps: { danger: true },
        onOk: async () => {
            if (savingRef.current) return;
            discarding.current = true; savingRef.current = true; setSaving(true);
            coverController.current?.abort(); setUploading(false);
            try {
                if (draftRef.current) await writeDraft(draftRef.current);
                await workflowDrafts.removeItem(id || "new");
                if (!id && createdId.current) await workflowDrafts.removeItem(createdId.current);
                if (!id && createdId.current) {
                    allowNavigation.current = true;
                    navigate(`/canvas/workflow/${encodeURIComponent(createdId.current)}`, { replace: true });
                    return;
                }
                dirtyRef.current = false; draftRef.current = null;
                setDraft(null); setInitial(null); setReload(value => value + 1);
            } catch (reason) {
                discarding.current = false;
                message.error("本机草稿未能清除，当前内容已保留");
                throw reason;
            } finally { savingRef.current = false; setSaving(false); }
        },
    });
    const uploadCover = async (file: File) => {
        coverController.current?.abort();
        const controller = new AbortController(); coverController.current = controller;
        setUploading(true);
        try {
            const result = await uploadPublicFile(file, controller.signal);
            controller.signal.throwIfAborted();
            form.setFieldValue("coverUrl", result.url);
            const current = draftRef.current!;
            store({ ...current, data: { ...current.data, coverUrl: result.url }, dirty: true });
        } catch (reason) { if (!controller.signal.aborted) message.error(reason instanceof Error ? reason.message : "封面上传失败"); }
        finally { if (coverController.current === controller) setUploading(false); }
        return Upload.LIST_IGNORE;
    };

    if (error) return <div className="p-5"><Alert type="error" title={error} action={<Button onClick={() => setReload(value => value + 1)}>重试</Button>} /></div>;
    if (!draft || !document) return <div className="grid h-full place-items-center"><Spin /></div>;
    return <div className="flex h-full min-h-0 flex-col" style={{ background: theme.canvas.background, color: theme.node.text }}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
            <Button type="text" disabled={saving} icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/admin/tutorials")}>返回教程管理</Button>
            <Workflow className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{draft.data.title || "新教程流程"}{draft.dirty ? " · 未保存" : ""}</span>
            <Button type="text" disabled={saving} icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>教程信息</Button>
            <Button type="text" loading={saving} disabled={uploading || conflict} icon={<Save className="size-4" />} onClick={() => void save()}>保存并返回</Button>
            <div inert={saving}><UserStatusActions variant="canvas" onOpenPlugins={() => setPluginsOpen(true)} onOpenShortcuts={() => setShortcutsOpen(true)} /></div>
        </div>
        {conflict ? <Alert type="warning" title="后台教程已更新，本机草稿基于旧版本；请保留所需内容后重新读取后台版本" action={<Button onClick={discardDraft}>重新读取</Button>} /> : null}
        {localError ? <Alert type="error" title={localError} /> : null}
        <div className="min-h-0 flex-1" inert={saving} aria-busy={saving}><CanvasEditor key={initial!.id} document={document} /></div>
        <CanvasPluginManagerModal open={pluginsOpen} onClose={() => setPluginsOpen(false)} />
        <CanvasShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <Drawer title="教程信息" size="large" open={settingsOpen} onClose={() => setSettingsOpen(false)} forceRender>
            <Form form={form} layout="vertical" disabled={saving} onValuesChange={(_, values) => { const current = draftRef.current!; const { published, position, ...data } = values; store({ ...current, data: { ...current.data, ...data }, published, position, dirty: true }); }}>
                <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: "请输入教程标题" }]}><Input /></Form.Item>
                <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
                <Form.Item name="category" label="分类"><Input /></Form.Item>
                <Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[",", "，"]} /></Form.Item>
                <Form.Item name="coverUrl" label="封面地址"><Input /></Form.Item>
                <Upload accept="image/*" showUploadList={false} beforeUpload={uploadCover}><Button loading={uploading}>上传封面</Button></Upload>
                <Form.Item name="position" label="排序" className="mt-4"><InputNumber className="!w-full" /></Form.Item>
                <Form.Item name="published" label="发布到公共库" valuePropName="checked"><Switch /></Form.Item>
                <p className="text-xs text-muted-foreground">节点、连线与示例媒体随流程保存。已发布教程保存后会更新公开版本，已插入用户画布的副本不受影响。</p>
            </Form>
        </Drawer>
    </div>;
}
