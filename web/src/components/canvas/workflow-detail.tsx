import { Alert, Button, Drawer, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { fetchAdminTutorial, fetchLibraryItem } from "@/services/api/admin";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { workflowGraphError, type WorkflowDocument } from "../../../../shared/tutorial-workflow";

export function WorkflowPreview({ flow }: { flow: WorkflowDocument }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    if (!flow.nodes.length) return <p className="text-sm text-muted-foreground">尚未添加节点</p>;
    const left = Math.min(...flow.nodes.map(node => node.position.x)) - 20;
    const top = Math.min(...flow.nodes.map(node => node.position.y)) - 20;
    const right = Math.max(...flow.nodes.map(node => node.position.x + node.width)) + 20;
    const bottom = Math.max(...flow.nodes.map(node => node.position.y + node.height)) + 20;
    const byId = new Map(flow.nodes.map(node => [node.id, node]));
    return <svg role="img" aria-label="节点流程预览" className="h-80 w-full rounded-xl border border-border" viewBox={`${left} ${top} ${right - left} ${bottom - top}`} style={{ background: theme.canvas.background }}>
        <title>节点流程预览</title>
        {flow.connections.map(edge => {
            const from = byId.get(edge.fromNodeId), to = byId.get(edge.toNodeId);
            return from && to ? <line key={edge.id} x1={from.position.x + from.width} y1={from.position.y + from.height / 2} x2={to.position.x} y2={to.position.y + to.height / 2} stroke={theme.node.muted} strokeWidth={2} /> : null;
        })}
        {[...flow.nodes].sort((a, b) => Number(b.type === "group") - Number(a.type === "group")).map(node => <g key={node.id} transform={`translate(${node.position.x} ${node.position.y})`}>
            <rect width={node.width} height={node.height} rx={10} fill={node.type === "group" ? "none" : theme.node.panel} stroke={theme.node.stroke} strokeDasharray={node.type === "group" ? "6 4" : undefined} />
            {node.type === "image" && node.metadata?.content ? <image href={node.metadata.content} x={8} y={32} width={Math.max(0, node.width - 16)} height={Math.max(0, node.height - 40)} preserveAspectRatio="xMidYMid meet" /> : null}
            <text x={12} y={23} fill={theme.node.text} fontSize={14}>{node.title.slice(0, 24) || node.type}</text>
            {node.type !== "image" && node.type !== "group" ? <text x={12} y={48} fill={theme.node.muted} fontSize={12}>{(node.metadata?.prompt || (node.type === "text" ? node.metadata?.content : "") || node.type).slice(0, 24)}</text> : null}
        </g>)}
    </svg>;
}

export function WorkflowDetail({ id, admin = false, onClose, onInsert }: { id: string | null; admin?: boolean; onClose: () => void; onInsert?: (id: string) => Promise<void> }) {
    const query = useQuery({ queryKey: [admin ? "admin" : "library", "tutorial-workflow", id], enabled: !!id, queryFn: ({ signal }) => admin ? fetchAdminTutorial(id!, signal) : fetchLibraryItem("tutorials", id!, signal) });
    const item = query.data;
    const invalid = item?.data.workflow ? workflowGraphError(item.data.workflow) : undefined;
    return <Drawer title={<span className="flex items-center gap-2"><Workflow className="size-4" />{item?.data.title || "AI 教程流程"}</span>} size="large" open={!!id} onClose={onClose} extra={id && onInsert && item?.data.workflow && !invalid ? <Button onClick={() => { onClose(); void onInsert(id); }}>插入画布</Button> : null}>
        {query.isPending ? <Spin /> : query.error || invalid ? <Alert type="error" title={invalid || query.error?.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : item?.data.workflow ? <div className="space-y-4"><p className="text-sm text-muted-foreground">{item.data.description}</p><p className="text-xs text-muted-foreground">{item.data.workflow.nodes.length} 个节点 · {item.data.workflow.connections.length} 条连线 · 插入后手动生成</p><WorkflowPreview flow={item.data.workflow} /></div> : <Alert type="warning" title="此教程已不是节点流程，请刷新列表" />}
    </Drawer>;
}
