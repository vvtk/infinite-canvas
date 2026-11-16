import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Alert,Button,DatePicker,Descriptions,Drawer,Input,Select,Space,Table,Tag} from "antd";
import {Eye,RefreshCw} from "lucide-react";
import {adminRequest,queryPath,type AiLog} from "@/services/api/admin";
import type {ApiParams} from "@/services/api/request";
import dayjs from "dayjs";
const statusNames:Record<string,string>={running:"进行中",success:"成功",error:"失败",cancelled:"已取消"};
export default function AdminLogsPage({details=false}:{details?:boolean}){
    const [draft,setDraft]=useState<ApiParams>({});
    const [filters,setFilters]=useState<ApiParams>({});
    const [selected,setSelected]=useState<AiLog|null>(null);
    const path=details?"ai-logs":"compute-logs";
    const query=useQuery({queryKey:["admin",path,filters],queryFn:()=>adminRequest<{items:AiLog[]}>(queryPath(`/${path}`,filters))});
    return <div className="space-y-5"><section className="rounded-2xl bg-card p-5"><Space wrap><Input placeholder="搜索用户或模型" value={String(draft.keyword||"")} onChange={event=>setDraft({...draft,keyword:event.target.value})} onPressEnter={()=>setFilters(draft)}/><Input placeholder="模型名称（精确匹配）" value={String(draft.model||"")} onChange={event=>setDraft({...draft,model:event.target.value})}/><Select allowClear placeholder="全部状态" className="w-32" value={draft.status||undefined} onChange={value=>setDraft({...draft,status:value})} options={Object.entries(statusNames).map(([value,label])=>({value,label}))}/><DatePicker.RangePicker value={draft.from&&draft.to?[dayjs(String(draft.from)),dayjs(String(draft.to))]:null} showTime onChange={value=>setDraft({...draft,from:value?.[0]?.toISOString(),to:value?.[1]?.toISOString()})}/><Button type="primary" onClick={()=>setFilters(draft)}>查询</Button><Button onClick={()=>{setDraft({});setFilters({});}}>重置</Button></Space></section>
    <section className="rounded-2xl bg-card p-5"><div className="mb-4 flex items-center justify-between"><div><h1 className="font-semibold">{details?"AI 日志":"算力日志"}</h1><p className="mt-1 text-xs text-muted-foreground">浏览器上报的本站模型调用记录，用量以接口实际返回为准，非结算账单。</p></div><Button type="text" icon={<RefreshCw className="size-4"/>} onClick={()=>void query.refetch()} aria-label="刷新日志"/></div>{query.error?<Alert type="error" title={query.error.message} className="mb-4"/>:null}
    <Table<AiLog> rowKey={row=>row.userId+row.id} dataSource={query.data?.items||[]} loading={query.isFetching} scroll={{x:1050}} pagination={{defaultPageSize:10,showSizeChanger:true,showTotal:total=>`共 ${total} 条`}} columns={[
        {title:"时间",dataIndex:"startedAt",render:value=>new Date(value).toLocaleString()},
        {title:"用户",render:(_,row)=>row.user.displayName||row.user.username},
        {title:"模型",dataIndex:"model"},{title:"类型",dataIndex:"operation"},
        {title:"状态",dataIndex:"status",render:value=><Tag color={value==="success"?"success":value==="error"?"error":undefined}>{statusNames[value]||value}</Tag>},
        {title:"耗时",render:(_,row)=>row.finishedAt?`${Math.max(0,(Date.parse(row.finishedAt)-Date.parse(row.startedAt))/1000).toFixed(1)} s`:"—"},
        {title:"输入 / 输出 Token",render:(_,row)=>`${row.usage.inputTokens??"—"} / ${row.usage.outputTokens??"—"}`},
        {title:"费用",render:()=>"—"},
        ...(details?[{title:"操作",key:"view",render:(_:unknown,row:AiLog)=><Button type="text" icon={<Eye className="size-4"/>} onClick={()=>setSelected(row)}>详情</Button>}]:[]),
    ]}/></section>
    <Drawer title="AI 调用详情" size="large" open={!!selected} onClose={()=>setSelected(null)}>{selected?<div className="space-y-5"><Descriptions column={1} items={[{key:"id",label:"请求 ID",children:selected.id},{key:"model",label:"模型",children:selected.model},{key:"media",label:"参考 / 输出媒体",children:`${selected.media.inputCount}（${selected.media.inputTypes.join("、")||"无"}）/ ${selected.media.outputCount}（${selected.media.outputType}）`},{key:"params",label:"参数",children:JSON.stringify(selected.parameters)}]}/>{[["输入",selected.inputText],["输出",selected.outputText],["错误",selected.error]].map(([label,value])=><section key={label}><h2 className="mb-2 text-sm font-medium">{label}</h2><pre className="whitespace-pre-wrap break-words rounded-xl bg-muted p-4 text-sm">{value||"—"}</pre></section>)}</div>:null}</Drawer></div>;
}
