import {useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {App,Alert,Button,Drawer,Form,Input,Modal,Space,Switch,Table,Tag} from "antd";
import {Pencil,Plus,RefreshCw,Trash2} from "lucide-react";
import {adminRequest,type PromptSourceRecord} from "@/services/api/admin";

export function SourceManager({open,onClose}:{open:boolean;onClose:()=>void}){
    const {message,modal}=App.useApp();
    const client=useQueryClient();
    const query=useQuery({queryKey:["admin","prompt-sources"],queryFn:()=>adminRequest<{items:PromptSourceRecord[]}>("/prompt-sources"),enabled:open});
    const [editing,setEditing]=useState<PromptSourceRecord|null|undefined>();
    const [busy,setBusy]=useState("");
    const [form]=Form.useForm();
    const refresh=async()=>{await Promise.all([client.invalidateQueries({queryKey:["admin","prompt-sources"]}),client.invalidateQueries({queryKey:["admin","library","prompts"]}),client.invalidateQueries({queryKey:["prompts"]}),client.invalidateQueries({queryKey:["side-panel-prompts"]}),client.invalidateQueries({queryKey:["library","prompt-sources"]})]);};
    const action=async(key:string,run:()=>Promise<unknown>)=>{setBusy(key);try{await run();await refresh();return true;}catch(error){message.error(error instanceof Error?error.message:"操作失败");return false;}finally{setBusy("");}};
    const sync=async(id?:string)=>action(id||"all",async()=>{const result=await adminRequest<{status?:string;error?:string;results?:Array<{status:string;error?:string}>}>(id?`/prompt-sources/${id}/sync`:"/prompt-sources/sync",{});const results=result.results||[result];if(results.some(item=>item.status==="error"))message.warning("部分来源同步失败，已保留上次成功数据，请查看状态。");else if(results.some(item=>item.status==="running"))message.info("来源正在同步，请稍后刷新。");else message.success("同步完成");});
    const edit=(source:PromptSourceRecord|null)=>{form.resetFields();form.setFieldsValue(source||{enabled:true});setEditing(source);};
    const save=async()=>{const values=await form.validateFields();if(await action("save",()=>adminRequest(editing?`/prompt-sources/${editing.id}`:"/prompt-sources",{...values,...(editing?{revision:Number(editing.revision)}:{})},editing?"PATCH":"POST")))setEditing(undefined);};
    return <><Drawer title="提示词来源" size="large" open={open} onClose={onClose} extra={<Space><Button icon={<RefreshCw className="size-4"/>} loading={busy==="all"} disabled={!!busy&&busy!=="all"} onClick={()=>void sync()}>全部同步</Button><Button type="primary" icon={<Plus className="size-4"/>} onClick={()=>edit(null)}>新增来源</Button></Space>}>
        <p className="mb-4 text-sm text-muted-foreground">来源配置和同步结果由本站统一保存。定时同步间隔可在系统配置中设置。</p>{query.error?<Alert title={query.error.message} type="error" className="mb-4"/>:null}
        <Table<PromptSourceRecord> rowKey="id" loading={query.isFetching} dataSource={query.data?.items||[]} pagination={false} scroll={{x:630}} columns={[
            {title:"来源",render:(_,source)=><div><a href={source.homepage||source.url} target="_blank" rel="noreferrer" className="font-medium">{source.name}</a><div className="mt-1 text-xs text-muted-foreground">{source.count} 条 · {source.last_success_at?new Date(source.last_success_at).toLocaleString():"尚未同步"}</div>{source.last_error?<div className="mt-1 text-xs text-destructive">{source.last_error}</div>:null}</div>},
            {title:"启用",render:(_,source)=><Switch size="small" checked={source.enabled} disabled={!!busy} onChange={enabled=>void action(source.id,()=>adminRequest(`/prompt-sources/${source.id}`,{name:source.name,url:source.url,homepage:source.homepage,enabled,revision:Number(source.revision)},"PATCH"))}/>},
            {title:"状态",render:(_,source)=><Tag color={source.last_error?"error":source.last_success_at?"success":undefined}>{source.last_error?"失败":source.last_success_at?"已同步":"未同步"}</Tag>},
            {title:"操作",render:(_,source)=><Space><Button size="small" loading={busy===source.id} disabled={!!busy&&busy!==source.id} onClick={()=>void sync(source.id)}>同步</Button><Button type="text" icon={<Pencil className="size-4"/>} onClick={()=>edit(source)} aria-label="编辑来源"/><Button type="text" danger icon={<Trash2 className="size-4"/>} aria-label="删除来源" onClick={()=>modal.confirm({title:`删除来源「${source.name}」？`,content:"该来源的提示词将不再公开展示，用户已收藏的副本保留。",onOk:async()=>{await action(source.id,()=>adminRequest(`/prompt-sources/${source.id}`,undefined,"DELETE"));}})}/></Space>},
        ]}/></Drawer>
        <Modal title={editing?"编辑来源":"新增来源"} open={editing!==undefined} onCancel={()=>setEditing(undefined)} onOk={()=>void save()} confirmLoading={busy==="save"} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label="名称" rules={[{required:true,whitespace:true}]}><Input/></Form.Item><Form.Item name="url" label="JSON 地址" rules={[{required:true,type:"url",message:"请输入公开 HTTP(S) 地址"}]}><Input/></Form.Item><Form.Item name="homepage" label="来源主页"><Input/></Form.Item><Form.Item name="enabled" label="启用" valuePropName="checked"><Switch/></Form.Item><p className="text-xs text-muted-foreground">JSON 顶层为数组，每项须有稳定的 id、title 和 prompt。同步失败时保留上次成功内容。</p></Form></Modal>
    </>;
}
