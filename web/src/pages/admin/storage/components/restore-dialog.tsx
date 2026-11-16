import { useState } from "react";
import { Alert, App, Form, Modal, Select, Table, Tag } from "antd";
import { createStorageTask, storageBytes, type RestorePreview, type StoragePool } from "@/services/api/storage";

export default function RestoreDialog({ preview, pools, defaultPoolId, onClose, onCreated }: { preview: RestorePreview; pools: StoragePool[]; defaultPoolId: string | null; onClose: () => void; onCreated: () => void }) {
    const { message, modal } = App.useApp();
    const [target, setTarget] = useState<string | undefined>(defaultPoolId || pools.find(pool => pool.writable)?.id);
    const [selected, setSelected] = useState<string[]>(preview.entries.filter(item => item.state === "missing").map(item => item.key));
    const [saving, setSaving] = useState(false);
    const restore = async () => {
        if (!target) { message.error("请选择恢复目标池"); return; }
        setSaving(true);
        try {
            await createStorageTask({ kind: "restore", backupId: preview.backupId, previewId: preview.id, targetPoolId: target, selected });
            message.success("恢复任务已创建，请在任务记录中刷新进度"); onCreated(); onClose();
        } catch (error) { message.error(error instanceof Error ? error.message : "创建失败"); }
        finally { setSaving(false); }
    };
    const confirm = () => {
        const conflicts = preview.entries.filter(item => selected.includes(item.key) && item.state === "conflict");
        if (conflicts.length) modal.confirm({ title: `确认覆盖 ${conflicts.length} 项现有内容？`, content: "包含删除墓碑的现有记录将按选择恢复，私有记录产生新的同步修订；公共内容恢复为未发布。执行前仍会检查修订号和配额。", okText: "确认覆盖并恢复", cancelText: "返回检查", onOk: restore });
        else void restore();
    };
    return <Modal open title="恢复预览" width={900} onCancel={onClose} onOk={confirm} confirmLoading={saving} okText="创建恢复任务" cancelText="取消" maskClosable={!saving}>
        <Alert className="!mb-5" type="warning" showIcon title="默认只补缺失记录；勾选冲突项表示明确覆盖，Logo 需要单独勾选。" description="备份中的媒体会恢复到所选池并保留原始归属，已有相同内容的媒体也会切换到恢复副本。未选择的业务记录保持现状；所有私有数据仍属于原账号。" />
        <Form layout="vertical"><Form.Item label="恢复目标池" required><Select value={target} onChange={setTarget} options={pools.filter(pool => pool.writable).map(pool => ({ value: pool.id, label: pool.name }))} placeholder="选择允许写入的池" /></Form.Item></Form>
        <Table size="small" rowKey="key" loading={saving} scroll={{ x: 600 }} pagination={{ pageSize: 8 }} dataSource={preview.entries} rowSelection={{ selectedRowKeys: selected, onChange: keys => setSelected(keys.map(String)) }} columns={[
            { title: "内容", dataIndex: "label", ellipsis: true },
            { title: "类型", dataIndex: "kind", render: (value: string) => ({ record: "用户记录", library: "公共内容", logo: "站点 Logo" })[value] },
            { title: "账号", dataIndex: "userId", render: (value: string) => value || "—" },
            { title: "当前状态", dataIndex: "state", render: (value: string) => <Tag color={value === "missing" ? "success" : "warning"}>{value === "missing" ? "缺失，默认恢复" : "已有内容，默认保留"}</Tag> },
        ]} />
        {preview.usage.length ? <><p className="mb-3 mt-5 text-sm text-muted-foreground">配额预览按全部关联记录恢复的新增占用上界估算；最终按所选记录检查，备份副本不计入用户配额。</p><Table size="small" rowKey="userId" pagination={false} scroll={{ x: 560 }} dataSource={preview.usage} columns={[
            { title: "账号", dataIndex: "username" }, { title: "当前占用", dataIndex: "usedBytes", render: storageBytes }, { title: "额度", dataIndex: "quotaBytes", render: storageBytes }, { title: "预计新增上界", dataIndex: "estimatedAddedBytes", render: storageBytes },
        ]} /></> : null}
    </Modal>;
}
