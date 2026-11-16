import { useEffect, useState } from "react";
import { Alert, App, Form, Input, InputNumber, Modal, Select, Switch } from "antd";
import { saveStoragePool, storagePoolInput, type StoragePool, type StoragePoolInput } from "@/services/api/storage";

export default function PoolEditor({ open, pool, onClose, onSaved }: { open: boolean; pool?: StoragePool; onClose: () => void; onSaved: () => void }) {
    const [form] = Form.useForm<StoragePoolInput>(), [saving, setSaving] = useState(false);
    const { message } = App.useApp();
    const provider = Form.useWatch("provider", form);
    useEffect(() => {
        if (!open) return;
        form.resetFields();
        form.setFieldsValue(pool ? storagePoolInput(pool) : { provider: "s3", prefix: "", pathStyle: true, writable: true, capacityBytes: null, accessKey: "", secretKey: "" });
    }, [open, pool, form]);
    const save = async () => {
        let values: StoragePoolInput;
        try { values = await form.validateFields(); } catch { return; }
        setSaving(true);
        try {
            await saveStoragePool({ ...values, prefix: values.prefix || "", accessKey: values.accessKey || "", secretKey: values.secretKey || "", pathStyle: values.pathStyle ?? true, revision: pool?.revision }, pool?.id);
            message.success("存储池已保存"); onSaved(); onClose();
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    return <Modal title={pool ? "编辑存储池" : "添加存储池"} open={open} onCancel={onClose} onOk={() => void save()} confirmLoading={saving} okText="保存" cancelText="取消" width={640} maskClosable={!saving}>
        <Alert className="!mb-5" type="info" showIcon title="凭据只保存在服务端，保存后不会回显。" description={pool ? "凭据留空表示保留，轮换时需同时填写两项。已有媒体、备份或任务引用时，修改存储位置请新建池并迁移。" : "请预先创建私有 Bucket，并允许本站来源通过 GET、POST、HEAD 跨域访问；连接测试只检查 Bucket 连接。"} />
        <Form form={form} layout="vertical" disabled={saving}>
            <div className="grid gap-x-5 sm:grid-cols-2">
                <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="例如：主存储、异地备份" /></Form.Item>
                <Form.Item name="provider" label="协议" rules={[{ required: true }]}><Select options={[{ value: "s3", label: "S3 兼容" }, { value: "oss", label: "阿里云 OSS 原生" }]} /></Form.Item>
            </div>
            <Form.Item name="endpoint" label="服务端 Endpoint" rules={[{ required: true, type: "url" }]} extra={provider === "oss" ? "填写区域 Endpoint，例如 https://oss-cn-hangzhou.aliyuncs.com，不含 Bucket 前缀。" : "后端能够访问的 HTTP(S) 服务地址，不带对象路径。"}><Input placeholder="https://…" /></Form.Item>
            <Form.Item name="publicEndpoint" label="浏览器访问 Endpoint" rules={[{ required: true, type: "url" }]} extra="必须能从用户浏览器访问，不能填写仅服务器可访问的容器主机名。OSS 同样填写不含 Bucket 前缀的区域地址。"><Input placeholder="https://…" /></Form.Item>
            <div className="grid gap-x-5 sm:grid-cols-2">
                <Form.Item name="region" label="Region" rules={[{ required: true }]}><Input placeholder={provider === "oss" ? "oss-cn-hangzhou" : "us-east-1"} /></Form.Item>
                <Form.Item name="bucket" label="Bucket" rules={[{ required: true }]}><Input /></Form.Item>
            </div>
            <Form.Item name="prefix" label="对象前缀" extra="可留空；不要以 / 开头，不支持 . 或 .. 路径段。"><Input placeholder="例如 infinite-canvas" /></Form.Item>
            <Form.Item name="capacityBytes" label="总容量（GB，可选）" extra="按套餐手动填写，1 GB = 10 亿字节。仅用于估算本池剩余容量，留空不估算。" getValueProps={(value: number | null | undefined) => ({ value: value == null ? null : value / 1_000_000_000 })} normalize={(value: number | null) => value == null ? null : Math.round(value * 1_000_000_000)} rules={[{ type: "number", min: 1, message: "请填写大于 0 的容量，或留空" }]}><InputNumber className="!w-full" min={0} placeholder="例如：200" /></Form.Item>
            <div className="grid gap-x-5 sm:grid-cols-2">
                <Form.Item name="accessKey" label="Access Key ID" rules={[{ required: !pool }]}><Input.Password autoComplete="new-password" placeholder={pool ? "留空保留" : "请输入"} /></Form.Item>
                <Form.Item name="secretKey" label="Secret Key" rules={[{ required: !pool }]}><Input.Password autoComplete="new-password" placeholder={pool ? "留空保留" : "请输入"} /></Form.Item>
            </div>
            <div className="flex gap-8"><Form.Item name="writable" label="允许新上传" valuePropName="checked"><Switch /></Form.Item>{provider === "s3" ? <Form.Item name="pathStyle" label="Path-style 寻址" valuePropName="checked"><Switch /></Form.Item> : null}</div>
        </Form>
    </Modal>;
}
