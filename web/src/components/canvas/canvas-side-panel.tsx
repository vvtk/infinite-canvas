import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { App, Alert, Button, Drawer, Dropdown, Empty, Input, Select, Spin, Tabs, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, Download, Ellipsis, Eye, FilePenLine, FileText, Folder, Images, Image as ImageIcon, LayoutGrid, Library, ListChecks, MessageSquareText, Music2, Plus, Rows3, Save, Search, Settings2, Square, Trash2, Type, Video, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { cn } from "@/lib/utils";
import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";
import { fetchSourcePrompts, fetchPublicPromptSources, type Prompt } from "@/services/api/prompts";
import { uploadMediaFile } from "@/services/file-storage";
import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision, uploadImage } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { fetchAdminWorkflows, fetchLibrary, type LibraryItem } from "@/services/api/admin";
import { Streamdown } from "streamdown";
import { CANVAS_SIDE_PANEL_MAX_WIDTH, CANVAS_SIDE_PANEL_MIN_WIDTH, CANVAS_SIDE_PANEL_MOTION_MS, CANVAS_SIDE_PANEL_NAV_WIDTH as NAV_WIDTH, useCanvasSidePanelStore, type CanvasSidePanelTab as PanelTab } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

import type { InsertAssetPayload } from "./asset-picker-modal";
import { WorkflowDetail } from "./workflow-detail";
import { CanvasPublicAssets } from "./canvas-public-assets";
import { ASSET_GROUPS, CanvasAssetCard, CanvasAssetGroup } from "./canvas-asset-items";
import { WORKFLOW_DRAG_TYPE } from "@/lib/canvas/tutorial-workflow";

const PANEL_MOTION_SECONDS = CANVAS_SIDE_PANEL_MOTION_MS / 1000;
const PANEL_EASE = [0.22, 1, 0.36, 1] as const;
type Props = {
    projectId: string;
    workflow?: { id?: string; busy: boolean };
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
    onPreviewNode: (nodeId: string) => void;
    onHoverNode: (nodeId: string | null) => void;
    onInsertAsset: (payload: InsertAssetPayload) => void;
    onInsertWorkflow: (id: string) => Promise<void>;
    onSave: () => Promise<void>;
};

const NODE_TYPE_ICON: Record<string, typeof Square> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Group]: Square,
};

const STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
    idle: "transparent",
};

export function CanvasSidePanel({ projectId, workflow, nodes, selectedNodeIds, onFocusNode, onPreviewNode, onHoverNode, onInsertAsset, onInsertWorkflow, onSave }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const tab = useCanvasSidePanelStore(state => state.tab);
    const setTab = useCanvasSidePanelStore(state => state.setTab);
    const [lastTab, setLastTab] = useState<PanelTab>("canvas");
    const width = useCanvasSidePanelStore((state) => state.width);
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const panelMounted = useCanvasSidePanelStore((state) => state.panelMounted);
    const panelClosing = useCanvasSidePanelStore((state) => state.panelClosing);
    const setWidth = useCanvasSidePanelStore((state) => state.setWidth);
    const [resizing, setResizing] = useState(false);
    const [saving, setSaving] = useState(false);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
            setWidth(nextWidth);
        };
        const onUp = () => {
            localStorage.setItem("canvas-side-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className={cn(tab ? "relative z-[60] flex h-full shrink-0" : "pointer-events-none absolute inset-y-0 left-5 z-[60]")}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? (tab ? width : NAV_WIDTH) + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
            style={{ overflow: tab ? "hidden" : "visible", pointerEvents: panelClosing ? "none" : undefined }}
        >
            <motion.aside
                className={cn("pointer-events-auto flex shrink-0 overflow-hidden", tab ? "relative h-full border-r" : "absolute left-0 top-1/2 h-auto -translate-y-1/2 flex-col items-center rounded-xl border p-2 shadow-lg backdrop-blur")}
                initial={{ x: -48 }}
                animate={{ x: panelClosing ? -28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
                style={{ width: tab ? width : NAV_WIDTH, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: tab ? theme.node.text : theme.toolbar.item, boxShadow: tab ? undefined : theme.toolbar.shadow }}
                data-canvas-no-zoom
            >
                {!tab ? (
                    <div className="flex w-full shrink-0 flex-col items-center justify-center gap-1">
                        <SideNavButton label={workflow ? "教程流程" : t("canvas.sidePanel.projects")} icon={workflow ? <Workflow className="size-4.5" /> : <Library className="size-4.5" />} theme={theme} onClick={() => (setLastTab("projects"), setTab("projects"))} />
                        <SideNavButton label={t("canvas.sidePanel.tutorials")} icon={<BookOpen className="size-4.5" />} theme={theme} onClick={() => (setLastTab("tutorials"), setTab("tutorials"))} />
                        <div className="my-1 h-px w-6" style={{ background: theme.toolbar.border }} />
                        <SideNavButton label={t("canvas.sidePanel.canvas")} icon={<LayoutGrid className="size-4.5" />} theme={theme} onClick={() => (setLastTab("canvas"), setTab("canvas"))} />
                        <SideNavButton label={t("canvas.sidePanel.assets")} icon={<Images className="size-4.5" />} theme={theme} onClick={() => (setLastTab("assets"), setTab("assets"))} />
                        <SideNavButton label={t("canvas.sidePanel.prompts")} icon={<MessageSquareText className="size-4.5" />} theme={theme} onClick={() => (setLastTab("prompts"), setTab("prompts"))} />
                        <div className="my-1 h-px w-6" style={{ background: theme.toolbar.border }} />
                        <SideNavButton
                            label={workflow ? "保存并返回" : t("canvas.sidePanel.save")}
                            icon={<Save className={cn("size-4.5", (saving || workflow?.busy) && "animate-pulse")} />}
                            disabled={saving || workflow?.busy}
                            theme={theme}
                            onClick={async () => {
                                setSaving(true);
                                try {
                                    await onSave();
                                } finally {
                                    setSaving(false);
                                }
                            }}
                        />
                    </div>
                ) : null}
                <div className={cn("absolute inset-y-0 left-0 flex h-full min-w-0 flex-col", tab ? "" : "hidden")} style={{ width }}>
                    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3" style={{ borderColor: theme.toolbar.border }}>
                        <button type="button" onClick={() => setTab(null)} className="grid size-8 shrink-0 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("canvas.sidePanel.back")} title={t("canvas.sidePanel.back")}>
                            <ArrowLeft className="size-4" />
                        </button>
                        <span className="truncate text-base font-semibold">{workflow && (tab || lastTab) === "projects" ? "教程流程" : t(`canvas.sidePanel.${tab || lastTab}`)}</span>
                    </div>
                    <div className={cn("min-h-0 flex-1 overflow-hidden", tab === "canvas" ? "" : "hidden")}><CanvasNodesTab nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={onFocusNode} onPreviewNode={onPreviewNode} onHoverNode={onHoverNode} theme={theme} /></div>
                    <div className={cn("min-h-0 flex-1 overflow-hidden", tab === "projects" ? "" : "hidden")}>{workflow ? <CanvasWorkflowsTab tutorialId={workflow.id} busy={workflow.busy} enabled={tab === "projects"} theme={theme} /> : <CanvasProjectsTab projectId={projectId} theme={theme} />}</div>
                    <div className={cn("min-h-0 flex-1 overflow-hidden", tab === "tutorials" ? "" : "hidden")}><CanvasTutorialsTab theme={theme} onInsert={onInsertWorkflow} /></div>
                    <div className={cn("min-h-0 flex-1 overflow-hidden", tab === "assets" ? "" : "hidden")}><CanvasAssetsTab onInsert={onInsertAsset} theme={theme} /></div>
                    <div className={cn("min-h-0 flex-1 overflow-hidden", tab === "prompts" ? "" : "hidden")}><CanvasPromptsTab onInsert={onInsertAsset} theme={theme} /></div>
                    <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("canvas.sidePanel.resize")} />
                </div>
            </motion.aside>
        </motion.div>
    );
}

function CanvasWorkflowsTab({ tutorialId, busy, enabled, theme }: { tutorialId?: string; busy: boolean; enabled: boolean; theme: CanvasTheme }) {
    const navigate = useNavigate();
    const accountId = useUserStore(state => state.user?.id);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [expanded, setExpanded] = useState(true);
    const pageSize = 20;
    const query = useQuery({ queryKey: ["admin", "library", "tutorials", "workflow", accountId, keyword, page], queryFn: ({ signal }) => fetchAdminWorkflows({ keyword, page, pageSize }, signal), enabled });
    return <div className="flex h-full flex-col">
        <button type="button" disabled={busy || !tutorialId} onClick={() => navigate("/canvas/workflow/new")} className="mx-2.5 my-2.5 flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"><Plus className="size-4" />新建教程流程</button>
        <div className="px-3 pb-2"><Input size="small" allowClear prefix={<Search className="size-3.5" />} placeholder="搜索教程流程" value={keyword} onChange={event => { setKeyword(event.target.value); setPage(1); }} /></div>
        <button type="button" onClick={() => setExpanded(value => !value)} className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-sm opacity-70 transition hover:opacity-100">
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}<span className="min-w-0 flex-1 text-left">教程流程</span><span className="text-xs">{query.data?.total ?? 0}</span>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {expanded ? <>
                {query.isPending ? <div className="grid place-items-center py-6"><Spin /></div> : query.error ? <Alert type="error" title="教程流程加载失败" action={<button type="button" onClick={() => void query.refetch()}>重试</button>} /> : null}
                {query.data?.items.map(item => <button key={item.id} type="button" disabled={busy} aria-current={item.id === tutorialId ? "page" : undefined} onClick={() => { if (item.id !== tutorialId) navigate(`/canvas/workflow/${encodeURIComponent(item.id)}`); }} className="mb-1 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-black/5 disabled:cursor-not-allowed dark:hover:bg-white/10" style={item.id === tutorialId ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : undefined}>
                    <Workflow className="size-5 shrink-0 opacity-70" /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.data.title}</span><span className="block truncate text-xs opacity-50">{item.data.workflowSummary?.nodeCount ?? 0} 个节点 · {item.published ? "已发布" : "草稿 / 下架"}</span></span>
                </button>)}
                {query.isSuccess && !query.data.total ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? "没有匹配的教程流程" : "暂无教程流程"} /> : null}
            </> : null}
        </div>
        {expanded && (query.data?.total || 0) > pageSize ? <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3 text-xs"><button type="button" disabled={page === 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页</span><button type="button" disabled={page * pageSize >= (query.data?.total || 0) || query.isFetching} onClick={() => setPage(value => value + 1)}>下一页</button></div> : null}
    </div>;
}

function CanvasProjectsTab({ projectId, theme }: { projectId: string; theme: CanvasTheme }) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [projectsOpen, setProjectsOpen] = useState(true);
    const create = () => navigate(`/canvas/${createProject(t("canvas.defaultTitle", { count: projects.length + 1 }))}`);
    const remove = (id: string) => {
        deleteProjects([id]);
        if (id === projectId) {
            const next = projects.find((project) => project.id !== id);
            navigate(next ? `/canvas/${next.id}` : "/canvas");
        }
    };
    return <div className="flex h-full flex-col">
        <button type="button" onClick={create} className="flex h-11 items-center justify-center gap-2 rounded-lg border-2 text-sm font-medium transition hover:bg-black/5 dark:hover:bg-white/10" style={{ margin: 10, borderColor: theme.toolbar.border }}><Plus className="size-4" />{t("canvas.sidePanel.newProject")}</button>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            <button type="button" onClick={() => setProjectsOpen((open) => !open)} className="flex w-full items-center gap-2 px-3 py-2 text-sm opacity-70 transition hover:opacity-100">
                {projectsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                <span className="min-w-0 flex-1 text-left">{t("canvas.sidePanel.myProjects")}</span>
                <span className="text-xs opacity-70">{projects.length}</span>
            </button>
            {projectsOpen ? <div className="px-2">
                {projects.map((project) => <div key={project.id} className="group mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition" style={project.id === projectId ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : undefined}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => navigate(`/canvas/${project.id}`)}>
                        {project.id === projectId ? <LayoutGrid className="size-5 shrink-0" /> : <Folder className="size-5 shrink-0 opacity-70" />}
                        {editingId === project.id ? <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { renameProject(project.id, draft); setEditingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { renameProject(project.id, draft); setEditingId(null); } if (event.key === "Escape") setEditingId(null); }} onClick={(event) => event.stopPropagation()} className="min-w-0 flex-1 bg-transparent outline-none" /> : <span className="min-w-0 flex-1 truncate">{project.title}</span>}
                    </button>
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomRight"
                        menu={{
                            items: [
                                { key: "rename", icon: <FilePenLine className="size-4" />, label: t("canvas.sidePanel.renameProject") },
                                { key: "delete", icon: <Trash2 className="size-4" />, label: t("canvas.sidePanel.deleteProject"), danger: true },
                            ],
                            onClick: ({ key }) => {
                                if (key === "rename") {
                                    setEditingId(project.id);
                                    setDraft(project.title);
                                }
                                if (key === "delete") modal.confirm({ title: t("canvas.sidePanel.deleteProjectTitle"), okText: t("common.confirm"), cancelText: t("common.cancel"), okButtonProps: { danger: true }, onOk: () => remove(project.id) });
                            },
                        }}
                    >
                        <button type="button" className="grid size-8 shrink-0 place-items-center rounded-md opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.projectActions")} title={t("canvas.sidePanel.projectActions")} onClick={(event) => event.stopPropagation()}><Ellipsis className="size-5" /></button>
                    </Dropdown>
                </div>)}
            </div> : null}
        </div>
    </div>;
}

function CanvasTutorialsTab({ theme, onInsert }: { theme: CanvasTheme; onInsert: (id: string) => Promise<void> }) {
    const navigate=useNavigate();const [selected,setSelected]=useState<LibraryItem|null>(null);
    const [workflowId,setWorkflowId]=useState<string|null>(null);
    const [page,setPage]=useState(1);
    const query=useQuery({queryKey:["library","tutorials",page],queryFn:()=>fetchLibrary("tutorials",{page,pageSize:20})});
    return <div className="flex h-full flex-col"><div className="px-3 py-2 text-xs opacity-60">教程中心</div><div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
    {query.isPending?<Spin/>:query.error?<Alert type="error" title="公共教程加载失败" action={<button onClick={()=>void query.refetch()}>重试</button>}/>:null}
    {query.data?.items.map(item=>{
        const workflow=item.data.format==="workflow";
        const Icon=workflow?Workflow:BookOpen;
        return <div key={item.id} draggable={workflow} onDragStart={event=>{if(workflow){event.dataTransfer.setData(WORKFLOW_DRAG_TYPE,item.id);event.dataTransfer.effectAllowed="copy";}}} className="flex items-center gap-1 rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10">
            <button type="button" onClick={()=>{if(workflow)setWorkflowId(item.id);else if(item.data.format==="markdown")setSelected(item);else if(item.data.href?.startsWith("/"))navigate(item.data.href);else if(item.data.href)window.open(item.data.href,"_blank","noopener,noreferrer");}} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left" title={workflow?"查看节点流程，可拖入画布":undefined}><Icon className="size-5 shrink-0" style={{color:theme.toolbar.activeText}}/><span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.data.title}</span><span className="text-xs opacity-50">{workflow?`${item.data.workflowSummary?.nodeCount||0} 个节点`:item.data.category||item.data.description}</span></span></button>
            {workflow?<button type="button" className="mr-1 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={()=>void onInsert(item.id)} aria-label={`插入流程：${item.data.title}`}><Plus className="size-3.5"/>插入画布</button>:null}
        </div>;
    })}
    {query.isSuccess&&!query.data.total?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开教程"/>:null}
    {(query.data?.total||0)>20?<div className="flex justify-between py-3 text-xs"><button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page}</span><button disabled={page*20>=(query.data?.total||0)} onClick={()=>setPage(page+1)}>下一页</button></div>:null}
    </div><Drawer title={selected?.data.title} size="large" open={!!selected} onClose={()=>setSelected(null)}><Streamdown>{selected?.data.content||""}</Streamdown></Drawer><WorkflowDetail id={workflowId} onClose={()=>setWorkflowId(null)} onInsert={onInsert}/></div>;
}

function SideNavButton({ label, icon, active, disabled, theme, onClick }: { label: string; icon: ReactNode; active?: boolean; disabled?: boolean; theme: CanvasTheme; onClick?: () => void }) {
    const [hovered, setHovered] = useState(false);
    return (
        <Button type="text" onClick={onClick} disabled={disabled} className="relative !h-8 !w-8 !min-w-8 !p-0" style={active ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : hovered && !disabled ? { background: theme.toolbar.itemHover, color: theme.toolbar.activeText } : { color: theme.toolbar.item, opacity: disabled ? 0.35 : 1 }} icon={icon} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} aria-label={label} title={label}>
            {active ? <motion.span layoutId="sidePanelNavIndicator" className="absolute -left-1 h-6 w-0.5 rounded-full" style={{ background: theme.toolbar.activeText }} transition={{ type: "spring", stiffness: 500, damping: 34 }} /> : null}
        </Button>
    );
}

// ---------------------------------------------------------------------------
// Canvas tab: list nodes and center, zoom, and select the clicked node.
// ---------------------------------------------------------------------------

const NODE_FILTER_VALUES = ["all", CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Text, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.Group];

function nodePreviewText(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return getNodeDefinition(node.type)?.title || node.type;
}

function CanvasNodesTab({ nodes, selectedNodeIds, onFocusNode, onPreviewNode, onHoverNode, theme }: { nodes: CanvasNodeData[]; selectedNodeIds: Set<string>; onFocusNode: (nodeId: string) => void; onPreviewNode: (nodeId: string) => void; onHoverNode: (nodeId: string | null) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [selectMode, setSelectMode] = useState(false);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [exporting, setExporting] = useState(false);
    const nodeViewMode = useCanvasSidePanelStore((state) => state.nodeViewMode);
    const setNodeViewMode = useCanvasSidePanelStore((state) => state.setNodeViewMode);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return nodes.filter((node) => (typeFilter === "all" || node.type === typeFilter) && (!query || [node.title, node.metadata?.content, node.metadata?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query)));
    }, [nodes, keyword, typeFilter]);
    const treeRows = useMemo(() => {
        const filteredIds = new Set(filtered.map((node) => node.id));
        const groups = new Set(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
        const children = new Map<string, CanvasNodeData[]>();
        filtered.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId && groups.has(groupId)) children.set(groupId, [...(children.get(groupId) || []), node]);
        });
        return nodes.flatMap((node) => {
            if (node.metadata?.groupId && groups.has(node.metadata.groupId)) return [];
            if (node.type !== CanvasNodeType.Group) return filteredIds.has(node.id) ? [{ node, depth: 0, hasChildren: false }] : [];
            const groupChildren = children.get(node.id) || [];
            if (!filteredIds.has(node.id) && !groupChildren.length) return [];
            return [{ node, depth: 0, hasChildren: groupChildren.length > 0 }, ...(collapsedGroups.has(node.id) ? [] : groupChildren.map((child) => ({ node: child, depth: 1, hasChildren: false })))];
        });
    }, [collapsedGroups, filtered, nodes]);

    const exitSelect = () => {
        setSelectMode(false);
        setChecked(new Set());
    };
    const toggleChecked = (id: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const allChecked = filtered.length > 0 && filtered.every((node) => checked.has(node.id));
    const toggleAll = () => setChecked(allChecked ? new Set() : new Set(filtered.map((node) => node.id)));

    // Let the hover preview fade out before the canvas starts moving to the node.
    const PRESS_FOCUS_DELAY = 180;
    const focusTimerRef = useRef<number | null>(null);
    useEffect(() => () => { if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current); }, []);
    const activateNode = (node: CanvasNodeData) => {
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
        const hasPreview = (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content);
        if (!hasPreview) {
            onFocusNode(node.id);
            return;
        }
        onHoverNode(null);
        focusTimerRef.current = window.setTimeout(() => {
            focusTimerRef.current = null;
            onFocusNode(node.id);
        }, PRESS_FOCUS_DELAY);
    };

    const handleExport = async () => {
        const targets = nodes.filter((node) => checked.has(node.id));
        if (!targets.length) return;
        setExporting(true);
        const hide = message.loading(t("canvas.sidePanel.exporting"), 0);
        try {
            await exportCanvasNodes(targets, t("canvas.sidePanel.exportName", { count: targets.length }));
            message.success(t("canvas.sidePanel.exported", { count: targets.length }));
            exitSelect();
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
            setExporting(false);
        }
    };

    return (
        <div className="flex h-full flex-col" onMouseLeave={() => onHoverNode(null)}>
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
                <span className="min-w-0 truncate text-xs font-medium opacity-60">{t("canvas.sidePanel.elements")}</span>
                {filtered.length ? <span className="shrink-0 text-xs opacity-35">{filtered.length}</span> : null}
                <button
                    type="button"
                    onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                    className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={selectMode ? { color: theme.toolbar.activeText, opacity: 1 } : undefined}
                >
                    <ListChecks className="size-3.5" />
                    {selectMode ? t("common.cancel") : t("canvas.sidePanel.select")}
                </button>
                {selectMode ? null : <Select size="small" variant="borderless" className="w-20" value={typeFilter} onChange={setTypeFilter} options={NODE_FILTER_VALUES.map((value) => ({ value, label: value === "all" ? t("common.all") : t(`canvas.sidePanel.filter.${value}`) }))} />}
                <button
                    type="button"
                    onClick={() => setNodeViewMode(nodeViewMode === "grid" ? "list" : "grid")}
                    className="flex shrink-0 items-center rounded-md px-1.5 py-1 opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    title={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                    aria-label={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                >
                    {nodeViewMode === "grid" ? <Rows3 className="size-3.5" /> : <LayoutGrid className="size-3.5" />}
                </button>
            </div>
            <div className="px-3 pb-2.5">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchNodes")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {nodeViewMode === "grid" ? (
                    filtered.length ? (
                        <div className="grid gap-2 px-1 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]">
                            {filtered.map((node) => {
                                const Icon = NODE_TYPE_ICON[node.type] || FileText;
                                const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                                const isChecked = checked.has(node.id);
                                const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                                return (
                                    <button
                                        key={node.id}
                                        type="button"
                                        data-node-item
                                        onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))}
                                        onMouseEnter={() => onHoverNode(node.id)}
                                        onMouseLeave={(event) => {
                                            const to = event.relatedTarget as Element | null;
                                            if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                        }}
                                        className="group relative flex min-w-0 flex-col rounded-lg p-1 text-left transition hover:bg-black/5 dark:hover:bg-white/5"
                                        style={active ? { background: theme.toolbar.activeBg } : undefined}
                                        title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}
                                    >
                                        <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-6 opacity-60" />}
                                            {selectMode ? (
                                                <span className="absolute left-1 top-1">
                                                    <CheckMark checked={isChecked} theme={theme} />
                                                </span>
                                            ) : null}
                                            {node.metadata?.status && node.metadata.status !== "idle" ? <span className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                        </span>
                                        <span className="mt-1 block truncate text-xs font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.noNodes")}</div>
                    )
                ) : treeRows.length ? (
                    <div className="space-y-1.5">
                        {treeRows.map(({ node, depth, hasChildren }) => {
                            const Icon = NODE_TYPE_ICON[node.type] || FileText;
                            const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                            const isChecked = checked.has(node.id);
                            const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                            return (
                                <div
                                    key={node.id}
                                    data-node-item
                                    className={cn("group relative flex items-center rounded-lg transition", depth && "ml-5", active ? "" : "hover:bg-black/5 dark:hover:bg-white/5")}
                                    style={active ? { background: theme.toolbar.activeBg } : undefined}
                                    onMouseEnter={() => onHoverNode(node.id)}
                                    onMouseLeave={(event) => {
                                        const to = event.relatedTarget as Element | null;
                                        if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                    }}
                                >
                                    {depth ? <span className="pointer-events-none absolute -left-3 top-[calc(-50%-0.4rem)] h-[calc(100%+0.4rem)] w-3 rounded-bl-md border-b border-l opacity-45" style={{ borderColor: theme.node.stroke }} /> : null}
                                    {node.type === CanvasNodeType.Group && hasChildren ? (
                                        <button type="button" onClick={() => setCollapsedGroups((prev) => (prev.has(node.id) ? new Set([...prev].filter((id) => id !== node.id)) : new Set(prev).add(node.id)))} className="ml-1 grid size-6 shrink-0 place-items-center opacity-55 transition hover:opacity-100" aria-label={node.title}>
                                            <ChevronRight className={cn("size-3.5 transition-transform", !collapsedGroups.has(node.id) && "rotate-90")} />
                                        </button>
                                    ) : null}
                                    <button type="button" onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))} className={cn("flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left", node.type === CanvasNodeType.Group && hasChildren ? "pl-0" : "pl-2")} title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}>
                                        {selectMode ? <CheckMark checked={isChecked} theme={theme} /> : null}
                                        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                                        </span>
                                        <span className="min-w-0 flex-1 space-y-0.5">
                                            <span className="block truncate text-sm font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                            <span className="block truncate text-xs leading-snug opacity-50">{nodePreviewText(node)}</span>
                                        </span>
                                        {node.metadata?.status && node.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                    </button>
                                    {selectMode || !isImage ? null : (
                                        <div className="flex shrink-0 flex-col items-center gap-0.5 pr-1.5">
                                            <button type="button" onClick={() => onPreviewNode(node.id)} className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.preview")} title={t("canvas.sidePanel.preview")}>
                                                <Eye className="size-3.5" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.noNodes")}</div>
                )}
            </div>
            {selectMode ? (
                <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <button type="button" onClick={toggleAll} className="rounded-md px-2 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
                        {allChecked ? t("canvas.sidePanel.clearAll") : t("workbench.selectAll")}
                    </button>
                    <span className="text-xs opacity-45">{t("canvas.sidePanel.selected", { count: checked.size })}</span>
                    <button
                        type="button"
                        onClick={() => void handleExport()}
                        disabled={!checked.size || exporting}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <Download className="size-3.5" />
                        {t("canvas.exportSelected")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function CheckMark({ checked, theme }: { checked: boolean; theme: CanvasTheme }) {
    return (
        <span className="grid size-4 shrink-0 place-items-center rounded border transition" style={{ borderColor: checked ? theme.toolbar.activeText : theme.node.stroke, background: checked ? theme.toolbar.activeText : "transparent" }}>
            {checked ? <Check className="size-3 text-white" /> : null}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Assets tab: collapsible type groups, tag filtering, and click-to-insert.
// ---------------------------------------------------------------------------

function buildInsertPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
}

const CanvasAssetsTab = memo(function CanvasAssetsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [scope, setScope] = useState("mine");
    const [keyword, setKeyword] = useState("");
    const [tagFilter, setTagFilter] = useState<string>("all");
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const allTags = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags || []))).slice(0, 20), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets.filter((asset) => (tagFilter === "all" || (asset.tags || []).includes(tagFilter)) && (!query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query)));
    }, [assets, keyword, tagFilter]);

    const groups = useMemo(() => ASSET_GROUPS.map((group) => ({ ...group, items: filtered.filter((asset) => asset.kind === group.kind) })).filter((group) => group.items.length > 0), [filtered]);

    const handleFiles = async (fileList: FileList | null) => {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        setUploading(true);
        const hide = message.loading(t("canvas.sidePanel.addingAssets"), 0);
        let added = 0;
        try {
            for (const file of files) {
                if (file.type.startsWith("image/")) {
                    const image = await uploadImage(file);
                    addAsset({ kind: "image", title: file.name || t("assets.kinds.image"), coverUrl: image.url, tags: [], data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                    added += 1;
                } else if (file.type.startsWith("video/")) {
                    const media = await uploadMediaFile(file, "video");
                    addAsset({ kind: "video", title: file.name || t("assets.kinds.video"), coverUrl: "", tags: [], data: { url: media.url, storageKey: media.storageKey, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType } });
                    added += 1;
                }
            }
            if (added) message.success(t("canvas.sidePanel.addedAssets", { count: added }));
            else message.warning(t("canvas.sidePanel.mediaOnly"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.addFailed"));
        } finally {
            hide();
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <div className="flex h-full flex-col">
            <Tabs className="shrink-0 px-3 [&_.ant-tabs-nav-wrap]:ml-[13px]" activeKey={scope} onChange={setScope} tabBarStyle={{ marginBottom: 8 }} items={[{ key: "mine", label: t("assets.title") }, { key: "public", label: t("assets.publicTitle") }]} />
            <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-1">
                <Input className="min-w-0 flex-1" size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchAssets")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
                <button
                    type="button"
                    disabled={scope !== "mine" || uploading}
                    aria-hidden={scope !== "mine"}
                    tabIndex={scope === "mine" ? undefined : -1}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn("flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10", scope !== "mine" && "invisible")}
                    style={{ color: theme.node.text }}
                >
                    <Plus className="size-3.5" />
                    {t("canvas.sidePanel.add")}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
            </div>
            <div className={cn("min-h-0 flex-1 flex-col", scope === "mine" ? "flex" : "hidden")}>
                <div className="hide-scrollbar flex h-9 shrink-0 items-start gap-1.5 overflow-x-auto whitespace-nowrap px-3 pb-2 [&_.ant-tag]:shrink-0">
                    <Tag.CheckableTag checked={tagFilter === "all"} className={cn("prompt-filter-tag", tagFilter === "all" && "is-active")} onChange={() => setTagFilter("all")}>
                        {t("common.all")}
                    </Tag.CheckableTag>
                    {allTags.map((tag) => (
                        <Tag.CheckableTag key={tag} checked={tagFilter === tag} className={cn("prompt-filter-tag", tagFilter === tag && "is-active")} onChange={() => setTagFilter((prev) => (prev === tag ? "all" : tag))}>
                            {tag}
                        </Tag.CheckableTag>
                    ))}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-gutter:stable]">
                    {groups.length ? (
                        <div className="space-y-1">
                            {groups.map(group => <CanvasAssetGroup key={group.kind} kind={group.kind} count={group.items.length}>
                                {group.items.map(asset => <CanvasAssetCard key={asset.id} asset={asset} theme={theme} onInsert={() => onInsert(buildInsertPayload(asset))} onRemove={() => (removeAsset(asset.id), message.success(t("canvas.sidePanel.assetRemoved")))} />)}
                            </CanvasAssetGroup>)}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noAssets")} className="pt-16" />
                    )}
                </div>
            </div>
            <CanvasPublicAssets active={scope === "public"} keyword={keyword} onInsert={onInsert} />
        </div>
    );
});

// ---------------------------------------------------------------------------
// Prompt library tab: collapsible source groups, lazy loading, and copy or text-node insertion actions.
// ---------------------------------------------------------------------------

const CanvasPromptsTab = memo(function CanvasPromptsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const sourcesQuery = useQuery({queryKey:["library","prompt-sources"],queryFn:fetchPublicPromptSources});
    const enabledSources = sourcesQuery.data?.items || [];
    const [keyword, setKeyword] = useState("");
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [detail, setDetail] = useState<Prompt | null>(null);

    const copyPrompt = async (prompt: string) => {
        try {
            await navigator.clipboard.writeText(prompt);
            message.success(t("canvas.sidePanel.promptCopied"));
        } catch {
            message.error(t("canvas.sidePanel.copyFailed"));
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="px-3 pb-2.5 pt-1">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchPrompts")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                <div className="space-y-1">
                    {sourcesQuery.error ? <Alert type="error" title="公共提示词库加载失败" action={<button onClick={()=>void sourcesQuery.refetch()}>重试</button>}/> : sourcesQuery.isPending ? <Spin/> : enabledSources.length ? enabledSources.map((source) => (
                        <PromptSourceGroup
                            key={source.id}
                            sourceId={source.id}
                            sourceName={source.name}
                            keyword={keyword}
                            open={!!expanded[source.id]}
                            theme={theme}
                            onToggle={() => setExpanded((prev) => ({ ...prev, [source.id]: !prev[source.id] }))}
                            onInsert={onInsert}
                            onView={setDetail}
                        />
                    )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noPrompts")} className="pt-12" />}
                </div>
            </div>
            <PromptDetailDialog prompt={detail} onClose={() => setDetail(null)} onCopy={(prompt) => void copyPrompt(prompt)} />
        </div>
    );
});

function PromptSourceGroup({
    sourceId,
    sourceName,
    keyword,
    open,
    theme,
    onToggle,
    onInsert,
    onView,
}: {
    sourceId: string;
    sourceName: string;
    keyword: string;
    open: boolean;
    theme: CanvasTheme;
    onToggle: () => void;
    onInsert: (payload: InsertAssetPayload) => void;
    onView: (prompt: Prompt) => void;
}) {
    const { t } = useTranslation();
    // Cache a source after its first expansion to avoid repeated requests; search results also need the data for counts.
    const showResults = open || !!keyword.trim();
    const query = useQuery({ queryKey: ["side-panel-prompts", sourceId], queryFn: () => fetchSourcePrompts(sourceId), enabled: showResults });

    const filtered = useMemo(() => {
        const items = query.data || [];
        const q = keyword.trim().toLowerCase();
        if (!q) return items;
        return items.filter((item) => [item.title, item.prompt, ...item.tags].join(" ").toLowerCase().includes(q));
    }, [query.data, keyword]);

    const insertPrompt = (item: Prompt) => onInsert({ kind: "text", content: item.prompt, title: item.title });

    return (
        <div>
            <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100">
                <ChevronRight className={cn("size-3.5 transition-transform", showResults && "rotate-90")} />
                <MessageSquareText className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{sourceName}</span>
                {showResults && query.isSuccess ? <span className="opacity-50">{filtered.length}</span> : null}
            </button>
            {showResults ? (
                <div className="px-1 pb-2 pt-1">
                    {query.isLoading ? (
                        <div className="flex justify-center py-6">
                            <Spin size="small" />
                        </div>
                    ) : query.isError ? (
                        <button type="button" onClick={() => void query.refetch()} className="block w-full py-4 text-center text-xs text-red-500 opacity-80 transition hover:opacity-100">
                            {t("canvas.sidePanel.loadFailedRetry")}
                        </button>
                    ) : filtered.length ? (
                        <div className="space-y-1.5">
                            {filtered.map((item) => (
                                <PromptRow key={item.id} item={item} theme={theme} onInsert={() => insertPrompt(item)} onView={() => onView(item)} />
                            ))}
                        </div>
                    ) : (
                        <div className="py-4 text-center text-xs opacity-40">{keyword.trim() ? t("canvas.sidePanel.noMatchingPrompts") : t("canvas.sidePanel.sourceEmpty")}</div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function PromptRow({ item, theme, onInsert, onView }: { item: Prompt; theme: CanvasTheme; onInsert: () => void; onView: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-black/5 dark:hover:bg-white/5">
            {item.coverUrl ? (
                <img src={item.coverUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" loading="lazy" />
            ) : (
                <span className="grid size-10 shrink-0 place-items-center rounded-md" style={{ background: theme.node.panel }}>
                    <FileText className="size-4 opacity-50" />
                </span>
            )}
            <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium leading-snug">{item.title}</div>
                <div className="mt-0.5 truncate text-xs leading-snug opacity-50">{item.prompt}</div>
            </button>
            <div className="flex shrink-0 flex-col items-center gap-0.5">
                <button type="button" onClick={onView} className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.viewDetails")} title={t("canvas.sidePanel.viewDetails")}>
                    <Eye className="size-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onInsert}
                    className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.activeText }}
                    aria-label={t("canvas.sidePanel.inserted")}
                    title={t("canvas.sidePanel.inserted")}
                >
                    <Plus className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
