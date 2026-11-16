import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Pagination, Segmented, Select, Spin } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { adminRequest } from "@/services/api/admin";
import { refreshSystemChannel } from "@/services/api/system-channel";
import { getAccount } from "@/lib/account-storage";
import { useConfigStore, guessCapability } from "@/stores/use-config-store";
import { ModelSelectModal } from "@/components/layout/model-select-modal";
import { ModelScriptEditor } from "@/components/layout/model-script-editor";
import { SystemPreferencesForm } from "@/components/system-channel/preferences-form";
import { pruneSystemModels, type SystemChannelConfig, type SystemChannelSnapshot, type SystemModel } from "../../../../../shared/system-channel";

export default function AdminSystemChannelPage({ modelsOnly = false }: { modelsOnly?: boolean }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<SystemChannelConfig | null>(null);
    const [saving, setSaving] = useState(false);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<SystemModel | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const channel = useConfigStore(state => state.config.channels.find(item => item.managedAccount === getAccount()));
    const query = useQuery({ queryKey: ["admin", "system-channel"], queryFn: () => adminRequest<SystemChannelSnapshot>("/system-channel"), refetchOnWindowFocus: false });
    useEffect(() => { if (query.data) { setDraft(query.data.data); setPage(1); } }, [query.data]);
    const updateModels = (models: SystemModel[]) => {
        setDraft(current => current && pruneSystemModels({ ...current, models }));
        setPage(current => Math.min(current, Math.max(1, Math.ceil(models.length / pageSize))));
    };
    const save = async () => {
        if (!draft || !query.data) return;
        setSaving(true);
        try {
            await adminRequest("/system-channel", { data: draft, revision: query.data.revision }, "PATCH");
            await Promise.all([query.refetch(), refreshSystemChannel()]);
            message.success("系统渠道已保存");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    if (query.isPending) return <Spin />;
    if (!draft || query.error) return <Alert type="error" showIcon title={query.error?.message || "配置加载失败"} action={<Button onClick={() => void query.refetch()}>重试</Button>} />;
    return <section className="space-y-6 rounded-2xl bg-card p-5 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-lg font-semibold">{modelsOnly ? "系统渠道模型" : "系统渠道配置"}</h1><p className="mt-1 text-sm text-muted-foreground">{modelsOnly ? "选择登录渠道模型，为每个模型指定能力和调用脚本。" : "管理开放模型与默认参数，用户的本地个性化配置优先。"}</p></div><div className="flex gap-2"><Button onClick={() => void query.refetch()}>重新加载</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存配置</Button></div></div>
        {modelsOnly ? <>
            <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">已选 {draft.models.length} 个模型</span><Button icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>选择模型</Button></div>
            <div className="divide-y divide-border rounded-xl border border-border px-3">{draft.models.length ? draft.models.slice((page - 1) * pageSize, page * pageSize).map(model => <div key={model.name} className="flex flex-wrap items-center gap-3 py-3"><span className="min-w-0 flex-1 break-all text-sm font-medium">{model.name}</span><Segmented size="small" value={model.capability} options={[{ value: "image", label: "生图" }, { value: "video", label: "视频" }, { value: "text", label: "文本" }, { value: "audio", label: "音频" }]} onChange={capability => updateModels(draft.models.map(item => item.name === model.name ? { ...item, capability: capability as SystemModel["capability"] } : item))} /><Button size="small" onClick={() => setScriptTarget(model)}>{model.script ? "已配置脚本" : "调用脚本"}</Button><Button type="text" danger aria-label={`移除 ${model.name}`} icon={<Trash2 className="size-4" />} onClick={() => updateModels(draft.models.filter(item => item.name !== model.name))} /></div>) : <p className="py-10 text-center text-sm text-muted-foreground">暂无模型，请从登录渠道读取或手动添加。</p>}</div>
            {draft.models.length ? <Pagination className="flex-wrap justify-end" current={page} pageSize={pageSize} total={draft.models.length} showSizeChanger showTotal={total => `共 ${total} 个模型`} onChange={(next, size) => { setPage(next); setPageSize(size); }} /> : null}
            <p className="text-xs text-muted-foreground">移除模型或调整能力会清除不再有效的开放项和默认模型；保存后生效。</p>
            <ModelSelectModal open={selectOpen} channel={channel || null} selectedNames={draft.models.map(model => model.name)} onConfirm={names => updateModels(names.map(name => draft.models.find(model => model.name === name) || { name, capability: guessCapability(name) }))} onClose={() => setSelectOpen(false)} />
            <ModelScriptEditor open={!!scriptTarget} capability={scriptTarget?.capability || "text"} modelName={scriptTarget?.name || ""} value={scriptTarget?.script || ""} onSave={script => updateModels(draft.models.map(model => model.name === scriptTarget?.name ? { ...model, script: script || undefined } : model))} onClose={() => setScriptTarget(null)} />
        </> : <>
            <div><label className="mb-2 block text-sm font-medium">系统可用模型</label><Select mode="multiple" className="w-full" placeholder="请先在系统渠道模型中配置，再选择开放模型" value={draft.enabledModels} options={draft.models.map(model => ({ label: model.name, value: model.name }))} onChange={enabledModels => setDraft(pruneSystemModels({ ...draft, enabledModels }))} /></div>
            <SystemPreferencesForm value={draft.defaults} models={draft.models.filter(model => draft.enabledModels.includes(model.name))} onChange={(key, value) => setDraft({ ...draft, defaults: { ...draft.defaults, [key]: value } })} />
        </>}
    </section>;
}
