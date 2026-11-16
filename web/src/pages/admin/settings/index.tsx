import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {App,Alert,Button,Form,Input,InputNumber,Select,Switch,Table,Upload} from "antd";
import {adminRequest,uploadPublicFile,type SiteSettings} from "@/services/api/admin";
import {useSiteStore} from "@/stores/use-site-store";
const GiB=1024**3;
export default function AdminSettingsPage(){
    const {message}=App.useApp();const [form]=Form.useForm();const [saving,setSaving]=useState(false);const [uploading,setUploading]=useState(false);
    const query=useQuery({queryKey:["admin","settings"],queryFn:()=>adminRequest<{data:SiteSettings;revision:number}>("/settings")});
    const audit=useQuery({queryKey:["admin","audit"],queryFn:()=>adminRequest<{items:Array<{id:string;username:string;action:string;target:string;summary:unknown;created_at:string}>}>("/audit")});
    useEffect(()=>{if(query.data)form.setFieldsValue({...query.data.data,storageGiB:query.data.data.defaultStorageBytes/GiB});},[query.data,form]);
    const save=async()=>{const {storageGiB,...values}=await form.validateFields();setSaving(true);try{await adminRequest("/settings",{data:{...values,defaultStorageBytes:Math.round(storageGiB*GiB)},revision:query.data?.revision},"PATCH");await Promise.all([query.refetch(),audit.refetch(),useSiteStore.getState().load()]);message.success("系统配置已保存");}catch(error){message.error(error instanceof Error?error.message:"保存失败");}finally{setSaving(false);}};
    return <div className="space-y-5"><section className="rounded-2xl bg-card p-6"><h1 className="mb-6 font-semibold">系统配置</h1>{query.error?<Alert type="error" title={query.error.message} action={<Button onClick={()=>void query.refetch()}>重试</Button>}/>:null}<Form form={form} layout="vertical" className="max-w-3xl" disabled={!query.data||saving}>
    <div className="grid gap-x-6 sm:grid-cols-2"><Form.Item name="siteName" label="站点名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="logoUrl" label="Logo 地址"><Input/></Form.Item></div>
    <Upload accept="image/*" showUploadList={false} beforeUpload={file=>{setUploading(true);void uploadPublicFile(file).then(media=>form.setFieldValue("logoUrl",media.url)).catch(error=>message.error(error.message)).finally(()=>setUploading(false));return false;}}><Button loading={uploading} className="mb-5">上传 Logo</Button></Upload>
    <Form.Item name="description" label="站点简介"><Input.TextArea rows={2}/></Form.Item><Form.Item name="announcement" label="站点公告"><Input.TextArea rows={3}/></Form.Item>
    <Form.Item name="hidePrivateChannels" label="隐藏私人渠道配置" valuePropName="checked" extra="对访客和普通用户隐藏私人渠道配置及导入入口；保留已有模型和系统渠道，管理员仍可配置。"><Switch/></Form.Item>
    <Form.Item name="userCloudStorageEnabled" label="启用用户云端存储" valuePropName="checked" extra="关闭后暂停所有账号的云同步、云媒体上传和下载，已有云数据与浏览器本地数据保留；登录、模型调用、WebDAV、公共素材和管理员存储维护仍可使用。已经签发的媒体链接会按原有效期失效。"><Switch/></Form.Item>
    <div className="my-5 border-t border-border pt-5"><h2 className="mb-4 text-sm font-medium">公共内容展示</h2><div className="flex flex-wrap gap-8">{Object.entries({prompts:"提示词",tutorials:"教程中心",skills:"公共 Skill",assets:"公共素材"}).map(([key,label])=><Form.Item key={key} name={["publicContent",key]} label={label} valuePropName="checked"><Switch/></Form.Item>)}</div></div>
    <div className="grid gap-x-6 sm:grid-cols-2"><Form.Item name="storageGiB" label="默认云存储额度（GiB）" rules={[{required:true,type:"number",min:1/GiB}]} extra="默认 2 GiB；用户个人额度优先。降低额度保留已有数据，超额时允许删除或缩小，拒绝新增占用。"><InputNumber className="!w-full"/></Form.Item><Form.Item name="promptSyncMinutes" label="服务端提示词同步" extra="失败保留上次成功内容，在下一周期重试。"><Select options={[{value:0,label:"关闭"},{value:30,label:"每 30 分钟"},{value:60,label:"每小时"},{value:360,label:"每 6 小时"},{value:1440,label:"每天"}]}/></Form.Item></div>
    <Button type="primary" loading={saving} disabled={uploading||!query.data} onClick={()=>void save()}>保存配置</Button></Form></section>
    <section className="rounded-2xl bg-card p-6"><h2 className="mb-5 font-semibold">管理操作记录</h2>{audit.error?<Alert type="error" title={audit.error.message}/>:null}<Table rowKey="id" dataSource={audit.data?.items||[]} loading={audit.isFetching} scroll={{x:720}} pagination={{pageSize:10}} columns={[{title:"操作者",dataIndex:"username"},{title:"操作",dataIndex:"action"},{title:"对象",dataIndex:"target",ellipsis:true},{title:"时间",dataIndex:"created_at",render:value=>new Date(value).toLocaleString()},{title:"变更摘要",dataIndex:"summary",ellipsis:true,render:value=>JSON.stringify(value)}]}/></section></div>;
}
