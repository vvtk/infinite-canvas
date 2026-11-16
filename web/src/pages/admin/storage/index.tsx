import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { ArrowRightLeft, Database, HardDrive, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { continueStorageTask, createStorageTask, deleteStorageBackup, deleteStoragePool, fetchStorageBackups, fetchStoragePools, fetchStorageTaskItems, fetchStorageTasks, previewStorageRestore, saveStoragePolicy, saveStoragePool, storageBytes, storagePoolInput, testStoragePool, type RestorePreview, type StoragePool, type StorageTask, type StorageTaskInput } from "@/services/api/storage";
import PoolEditor from "./components/pool-editor";
import RestoreDialog from "./components/restore-dialog";

const taskLabels = { migration: "迁移", backup: "备份", restore: "恢复", cleanup: "清理源副本", "delete-backup": "删除备份" };
const taskStates = { pending: "待执行", running: "执行中", failed: "已暂停", completed: "已完成" };
const backupStates = { building: "备份中", ready: "可恢复", deleting: "删除中", deleted: "已删除" };
const date = (value: string) => new Date(value).toLocaleString("zh-CN");

export default function AdminStoragePage() {
    const { message, modal } = App.useApp(), accountId = useUserStore(state => state.user?.id);
    const poolsQuery = useQuery({ queryKey: ["admin", "storage", "pools", accountId], queryFn: fetchStoragePools });
    const backupsQuery = useQuery({ queryKey: ["admin", "storage", "backups", accountId], queryFn: fetchStorageBackups });
    const tasksQuery = useQuery({ queryKey: ["admin", "storage", "tasks", accountId], queryFn: fetchStorageTasks });
    const [tab, setTab] = useState("pools"), [busy, setBusy] = useState(false);
    const [editor, setEditor] = useState<{ pool?: StoragePool } | null>(null);
    const [operation, setOperation] = useState<"migration" | "backup" | null>(null);
    const [preview, setPreview] = useState<RestorePreview | null>(null);
    const [detail, setDetail] = useState<StorageTask | null>(null), [taskForm] = Form.useForm();
    const detailQuery = useQuery({ queryKey: ["admin", "storage", "task", accountId, detail?.id], queryFn: () => fetchStorageTaskItems(detail!.id), enabled: !!detail });
    const pools = poolsQuery.data?.items || [], policy = poolsQuery.data?.policy;
    const poolName = (id: string | null) => pools.find(pool => pool.id === id)?.name || id || "—";
    const refresh = async () => { await Promise.all([poolsQuery.refetch(), backupsQuery.refetch(), tasksQuery.refetch()]); };
    const perform = async (action: () => Promise<unknown>, success: string) => {
        setBusy(true);
        try { await action(); message.success(success); await refresh(); return true; }
        catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); return false; }
        finally { setBusy(false); }
    };
    const launch = async (input: StorageTaskInput) => {
        const ok = await perform(() => createStorageTask(input), "维护任务已创建，请刷新查看进度");
        if (ok) { setOperation(null); setTab("tasks"); }
    };
    const openOperation = (kind: "migration" | "backup") => {
        taskForm.resetFields();
        taskForm.setFieldsValue({ sourcePoolId: pools.find(pool => pool.id !== policy?.defaultPoolId)?.id, targetPoolId: policy?.defaultPoolId || undefined });
        setOperation(kind);
    };
    const previewBackup = async (id: string) => {
        setBusy(true);
        try { setPreview(await previewStorageRestore(id)); }
        catch (error) { message.error(error instanceof Error ? error.message : "读取预览失败"); }
        finally { setBusy(false); }
    };
    const submitOperation = async () => {
        let values: { sourcePoolId: string; targetPoolId: string };
        try { values = await taskForm.validateFields(); } catch { return; }
        if (operation) await launch({ kind: operation, ...values });
    };
    const changeDefault = (id: string) => policy && perform(() => saveStoragePolicy({ ...policy, defaultPoolId: id }), "默认写入池已更新");
    const tasks = tasksQuery.data?.items || [], active = tasks.some(task => task.status === "pending" || task.status === "running");
    const poolOptions = pools.map(pool => ({ value: pool.id, label: pool.name }));
    const errors = [poolsQuery.error, backupsQuery.error, tasksQuery.error].filter(Boolean);
    return <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
            <div><h1 className="flex items-center gap-2 text-lg font-semibold"><HardDrive className="size-5" />存储管理</h1><p className="mt-1 text-sm text-muted-foreground">管理云端媒体、存储池和恢复副本。所有用量仅统计本项目登记数据。</p></div>
            <Button icon={<RefreshCw className="size-4" />} loading={poolsQuery.isFetching || backupsQuery.isFetching || tasksQuery.isFetching} onClick={() => void refresh()}>刷新</Button>
        </div>
        {errors.length ? <Alert type="error" showIcon title="存储管理数据加载失败" description={errors.map(error => error?.message).join("；")} /> : null}
        <section className="rounded-2xl bg-card p-5 sm:p-6">
            <Tabs activeKey={tab} onChange={setTab} items={[
                { key: "pools", label: <span className="inline-flex items-center gap-2"><Database className="size-4" />OSS 池</span>, children: <div className="space-y-5">
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div className="flex flex-wrap gap-4">
                            <div><div className="mb-2 text-sm text-muted-foreground">新上传分配</div><Select className="min-w-40" value={policy?.mode} disabled={busy || !policy?.defaultPoolId} options={[{ value: "single", label: "指定默认池" }, { value: "round-robin", label: "等权轮询" }]} onChange={mode => policy && void perform(() => saveStoragePolicy({ ...policy, mode }), "写入分配策略已更新")} /></div>
                            <div><div className="mb-2 text-sm text-muted-foreground">默认写入池</div><Select className="min-w-44" value={policy?.defaultPoolId || undefined} placeholder="添加可写存储池后设置" options={pools.filter(pool => pool.writable).map(pool => ({ value: pool.id, label: pool.name }))} disabled={busy} onChange={id => void changeDefault(id)} /></div>
                        </div>
                        <Space wrap><Button icon={<ArrowRightLeft className="size-4" />} disabled={busy || active || pools.length < 2} onClick={() => openOperation("migration")}>迁移</Button><Button icon={<ShieldCheck className="size-4" />} disabled={busy || active || pools.length < 2} onClick={() => openOperation("backup")}>备份</Button><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({})}>添加存储池</Button></Space>
                    </div>
                    <p className="text-sm text-muted-foreground">只向允许新上传的池分配文件；切换策略不搬动历史文件，单次上传选定后不自动切池。停止写入不影响已有文件读取。</p>
                    <Table<StoragePool> rowKey="id" dataSource={pools} loading={poolsQuery.isPending} scroll={{ x: 1320 }} pagination={{ pageSize: 10 }} locale={{ emptyText: <Empty description="尚未配置云端存储池" /> }} columns={[
                        { title: "存储池", dataIndex: "name", render: (name, pool) => <div><div className="font-medium">{name} {policy?.defaultPoolId === pool.id ? <Tag color="processing">默认</Tag> : null}</div><div className="mt-1 text-xs text-muted-foreground">{pool.provider === "oss" ? "阿里云 OSS" : "S3 兼容"} · {pool.region}</div></div> },
                        { title: "Bucket / 前缀", render: (_, pool) => <div className="max-w-52"><div className="truncate">{pool.bucket}{pool.prefix ? ` / ${pool.prefix}` : ""}</div><div className="mt-1 truncate text-xs text-muted-foreground">{pool.publicEndpoint}</div></div> },
                        { title: "允许新上传", render: (_, pool) => <Switch checked={pool.writable} disabled={busy || pool.id === policy?.defaultPoolId} onChange={writable => void perform(() => saveStoragePool({ ...storagePoolInput(pool), writable }, pool.id), writable ? "已允许新上传" : "已停止新上传")} /> },
                        { title: "媒体数", dataIndex: "mediaCount" }, { title: "业务占用", dataIndex: "usedBytes", render: storageBytes }, { title: "备份占用", dataIndex: "backupBytes", render: storageBytes },
                        { title: "容量概览", width: 200, render: (_, pool) => {
                            const used = pool.usedBytes + pool.backupBytes;
                            return <div className="space-y-1"><div>总容量 {pool.capacityBytes === null ? "未设置" : `${(pool.capacityBytes / 1_000_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 9 })} GB`}</div><div className="text-xs text-muted-foreground">已用 {storageBytes(used)}</div><div className="text-xs text-muted-foreground">估算剩余 {pool.capacityBytes === null ? "—" : storageBytes(Math.max(0, pool.capacityBytes - used))}{pool.capacityBytes !== null && used > pool.capacityBytes ? ` · 超出 ${storageBytes(used - pool.capacityBytes)}` : ""}</div></div>;
                        } },
                        { title: "操作", width: 220, render: (_, pool) => <Space wrap size={0}><Button type="link" size="small" disabled={busy} onClick={() => setEditor({ pool })}>编辑</Button><Button type="link" size="small" disabled={busy} onClick={() => void perform(async () => { const result = await testStoragePool(pool.id); message.info(result.message); }, "连接测试完成")}>测试</Button>{pool.writable && policy?.defaultPoolId !== pool.id ? <Button type="link" size="small" disabled={busy} onClick={() => void changeDefault(pool.id)}>设为默认</Button> : null}<Popconfirm title="删除存储池配置？" description="有媒体、备份或任务引用时不能删除。删除默认池后需重新指定默认池；不会删除 Bucket。" okText="删除配置" cancelText="取消" onConfirm={() => perform(() => deleteStoragePool(pool.id), "存储池配置已删除")}><Button danger type="link" size="small" disabled={busy}>删除</Button></Popconfirm></Space> },
                    ]} />
                    <p className="text-xs text-muted-foreground">有效上传预留计入业务占用。剩余容量按手动配置的总容量减去业务及备份占用估算，仅供参考；总容量为本池独立预算，共享 Bucket 或套餐时请分别分配预算。迁移遗留副本、未完成恢复副本和桶内未登记对象不包含在这里；源副本仅通过已完成迁移任务单独清理。</p>
                </div> },
                { key: "backups", label: <span className="inline-flex items-center gap-2"><ShieldCheck className="size-4" />备份</span>, children: <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">备份媒体、关联业务记录和跨池依赖；不包含 OAuth 凭据或整站数据库。</p><Button disabled={busy || active || pools.length < 2} onClick={() => openOperation("backup")}>创建备份</Button></div>
                    <Table rowKey="id" loading={backupsQuery.isPending} dataSource={backupsQuery.data?.items || []} scroll={{ x: 900 }} pagination={{ pageSize: 10 }} columns={[
                        { title: "备份", dataIndex: "id", ellipsis: true }, { title: "源池", dataIndex: "sourcePoolId", render: poolName }, { title: "备份池", dataIndex: "targetPoolId", render: poolName },
                        { title: "状态", dataIndex: "status", render: (status: keyof typeof backupStates) => <Tag color={status === "ready" ? "success" : "processing"}>{backupStates[status]}</Tag> },
                        { title: "媒体 / 记录", render: (_, row) => `${row.mediaCount} / ${row.recordCount}` }, { title: "占用", dataIndex: "bytes", render: storageBytes }, { title: "创建时间", dataIndex: "createdAt", render: date },
                        { title: "操作", render: (_, row) => <Space size={0}><Button size="small" type="link" disabled={busy || active || row.status !== "ready"} onClick={() => void previewBackup(row.id)}>恢复预览</Button><Popconfirm title="永久删除此备份？" description="仅删除该备份专属对象和清单，不删除在线文件。" okText="删除备份" cancelText="取消" onConfirm={() => perform(async () => { await deleteStorageBackup(row.id); setTab("tasks"); }, "备份删除任务已创建")}><Button size="small" danger type="link" disabled={busy || active || row.status !== "ready"}>删除</Button></Popconfirm></Space> },
                    ]} />
                </div> },
                { key: "tasks", label: "任务记录", children: <div className="space-y-4">
                    <Alert type="info" showIcon title="全站同时执行一个维护任务，每次传输一个对象。" description="失败或服务重启保留进度，由管理员手动继续；切换页面不会停止任务。点击刷新查看最新进度，恢复冲突变化时需重新预览并创建任务。" />
                    <Table<StorageTask> rowKey="id" loading={tasksQuery.isPending} dataSource={tasks} scroll={{ x: 1080 }} pagination={{ pageSize: 10 }} columns={[
                        { title: "任务", width: 130, render: (_, task) => <div><span className="font-medium">{taskLabels[task.kind]}</span><div className="mt-1 max-w-28 truncate text-xs text-muted-foreground" title={task.id}>{task.id}</div></div> },
                        { title: "源池 → 目标池", render: (_, task) => <span>{poolName(task.sourcePoolId)} → {poolName(task.targetPoolId)}</span> },
                        { title: "状态", dataIndex: "status", render: (status: StorageTask["status"]) => <Tag color={status === "completed" ? "success" : status === "failed" ? "warning" : "processing"}>{taskStates[status]}</Tag> },
                        { title: "进度", width: 190, render: (_, task) => <div><Progress size="small" percent={task.total ? Math.round(task.completed / task.total * 100) : task.status === "completed" ? 100 : 0} status={task.status === "failed" ? "exception" : task.status === "completed" ? "success" : "normal"} /><div className="text-xs text-muted-foreground">{task.completed} / {task.total} · {storageBytes(task.completedBytes)} / {storageBytes(task.bytes)}</div></div> },
                        { title: "说明", dataIndex: "error", width: 260, render: (error: string) => error || "—" }, { title: "更新时间", dataIndex: "updatedAt", render: date },
                        { title: "操作", width: 190, render: (_, task) => <Space size={0} wrap><Button size="small" type="link" onClick={() => setDetail(task)}>明细</Button>{task.status === "failed" ? <Button size="small" type="link" disabled={busy || active} onClick={() => void perform(() => continueStorageTask(task.id), "任务已继续，请刷新查看进度")}>继续</Button> : null}{task.kind === "migration" && task.status === "completed" ? <Button size="small" type="link" danger disabled={busy || active} onClick={() => modal.confirm({ title: "清理此迁移任务的源副本？", content: "仅清理已完成迁移且无在线引用的源对象。已有签名全部失效后才允许删除；备份或其他任务仍引用时拒绝清理。", okText: "创建清理任务", cancelText: "取消", onOk: () => launch({ kind: "cleanup", migrationTaskId: task.id }) })}>清理源副本</Button> : null}</Space> },
                    ]} />
                </div> },
            ]} />
        </section>
        <PoolEditor open={!!editor} pool={editor?.pool} onClose={() => setEditor(null)} onSaved={() => void refresh()} />
        <Modal open={!!operation} title={operation === "migration" ? "迁移媒体到其他池" : "创建媒体及关联数据备份"} okText="创建任务" cancelText="取消" confirmLoading={busy} onCancel={() => setOperation(null)} onOk={() => void submitOperation()}>
            <Alert className="!mb-5" showIcon type="info" title={operation === "migration" ? "源池会停止新上传，校验成功后逐个切换媒体索引，源文件保留。" : "在线引用保持不变，媒体和快照复制到目标池的独立备份目录。"} description={operation === "migration" ? "迁移前请先将默认写入池切到其他池；有效上传预留需完成或过期后再手动继续任务。" : "自动补齐关联记录的跨池媒体；这是关联数据备份，不能代替整站数据库备份。"} />
            <Form layout="vertical" form={taskForm}><Form.Item name="sourcePoolId" label="源池" rules={[{ required: true }]}><Select options={poolOptions} /></Form.Item><Form.Item name="targetPoolId" label={operation === "migration" ? "迁移目标池" : "备份目标池"} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value !== getFieldValue("sourcePoolId") ? Promise.resolve() : Promise.reject(new Error("源池和目标池不能相同")) })]} dependencies={["sourcePoolId"]}><Select options={pools.filter(pool => operation === "backup" || pool.writable).map(pool => ({ value: pool.id, label: pool.name }))} /></Form.Item></Form>
        </Modal>
        {preview ? <RestoreDialog key={preview.id} preview={preview} pools={pools} defaultPoolId={policy?.defaultPoolId || null} onClose={() => setPreview(null)} onCreated={() => { setTab("tasks"); void refresh(); }} /> : null}
        <Modal open={!!detail} title="任务对象明细" width={850} footer={<Button onClick={() => setDetail(null)}>关闭</Button>} onCancel={() => setDetail(null)}>
            <div className="mb-4 flex items-center justify-between gap-3"><span className="truncate text-sm text-muted-foreground">{detail?.id}</span><Button size="small" loading={detailQuery.isFetching} onClick={() => void detailQuery.refetch()}>刷新明细</Button></div>
            {detailQuery.error ? <Alert type="error" title={detailQuery.error.message} /> : null}
            <Table rowKey="id" size="small" scroll={{ x: 640 }} loading={detailQuery.isFetching} dataSource={detailQuery.data?.items || []} pagination={{ pageSize: 10 }} columns={[{ title: "类型", dataIndex: "kind", render: (value: string) => ({ private: "用户媒体", public: "公共媒体", manifest: "备份清单" })[value] }, { title: "媒体 ID", dataIndex: "mediaId", ellipsis: true }, { title: "大小", dataIndex: "bytes", render: storageBytes }, { title: "状态", dataIndex: "status", render: (value: string) => ({ pending: "待处理", completed: "已复制并校验", cleaned: "已清理" })[value] }, { title: "源副本最早清理时间", dataIndex: "retireAfter", render: (value: string | null) => value ? date(value) : "—" }]} />
        </Modal>
    </div>;
}
