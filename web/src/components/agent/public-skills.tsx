import {useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {App,Alert,Button,Drawer,Empty,Input,Pagination} from "antd";
import {Streamdown} from "streamdown";
import {fetchLibrary,fetchLibraryItem,type LibraryItem} from "@/services/api/admin";
import {createCodexSkill,fetchCodexSkills} from "@/services/api/canvas-agent";
import {useAgentStore} from "@/stores/use-agent-store";
import {useAgentSkillStore} from "@/stores/use-agent-skill-store";
export function PublicSkills({blocked,onBusyChange}:{blocked:boolean;onBusyChange:(busy:boolean)=>void}){
    const blockedRef=useRef(blocked);blockedRef.current=blocked;
    const {message}=App.useApp();const [keyword,setKeyword]=useState("");const [page,setPage]=useState(1);const [selected,setSelected]=useState<LibraryItem|null>(null);const [busy,setBusy]=useState("");
    const connected=useAgentStore(state=>state.connected);const sending=useAgentStore(state=>state.sending);const waiting=useAgentStore(state=>state.waiting);const draft=useAgentSkillStore(state=>state.draft);const generating=useAgentSkillStore(state=>state.generatingSource);
    const query=useQuery({queryKey:["library","skills",keyword,page],queryFn:()=>fetchLibrary("skills",{keyword,page,pageSize:20})});
    const install=async(item:LibraryItem)=>{
        const agent=useAgentStore.getState(),skills=useAgentSkillStore.getState(),revision=skills.connectionRevision;
        if(blockedRef.current||!agent.connected||agent.sending||agent.waiting||skills.draft||skills.generatingSource)return message.warning("请连接 Agent，完成当前任务后安装");
        const current=()=>{const state=useAgentStore.getState();return state.connected&&state.url===agent.url&&state.token===agent.token&&useAgentSkillStore.getState().connectionRevision===revision;};
        setBusy(item.id);onBusyChange(true);try{
            const [{data,errors},latest]=await Promise.all([fetchCodexSkills(agent.url,agent.token,true),fetchLibraryItem("skills",item.id)]);
            if(!current())return;
            if(!data||errors?.length)throw new Error("无法确认本地技能列表，请刷新后重试");
            const value=latest.data;
            if(data.some(skill=>skill.name.toLowerCase()===value.name?.toLowerCase()))throw new Error("已有同名技能，未覆盖本地内容");
            if(blockedRef.current||useAgentStore.getState().sending||useAgentStore.getState().waiting||useAgentSkillStore.getState().draft||useAgentSkillStore.getState().generatingSource)throw new Error("Agent 正忙，请稍后安装");
            await createCodexSkill(agent.url,agent.token,{name:value.name!,description:value.description,instructions:value.instructions!,interface:{displayName:value.title,...(value.defaultPrompt?{defaultPrompt:value.defaultPrompt}:{})}});
            if(!current())return;
            await useAgentSkillStore.getState().loadSkills(agent.url,agent.token,true);message.success("已安装到本地技能目录");
        }catch(error){if(current())message.error(error instanceof Error?error.message:"安装失败");}finally{setBusy("");onBusyChange(false);}
    };
    return <section className="border-t border-border py-4"><h2 className="mb-2 text-sm font-semibold">公共 Skill</h2><p className="mb-3 text-xs text-muted-foreground">先查看正文，再主动安装。同名技能保留本地版本。</p><Input.Search allowClear placeholder="搜索公共 Skill" onSearch={value=>{setKeyword(value);setPage(1);}}/>{query.error?<Alert type="error" className="mt-3" title="公共 Skill 加载失败" action={<Button size="small" onClick={()=>void query.refetch()}>重试</Button>}/>:null}
    {query.data?.items.map(item=><div key={item.id} className="border-b border-border py-3"><div className="text-sm font-medium">{item.data.title}</div><p className="my-2 line-clamp-2 text-xs text-muted-foreground">{item.data.description}</p><div className="flex justify-end gap-1"><Button type="text" size="small" onClick={()=>setSelected(item)}>查看</Button><Button type="text" size="small" loading={busy===item.id} disabled={blocked||!connected||sending||waiting||!!draft||!!generating||!!busy} onClick={()=>void install(item)}>安装</Button></div></div>)}
    {query.isSuccess&&!query.data.total?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共 Skill"/>:null}<Pagination simple current={page} pageSize={20} total={query.data?.total||0} onChange={setPage} showSizeChanger={false} className="mt-3"/>
    <Drawer title={selected?.data.title} size="large" open={!!selected} onClose={()=>setSelected(null)}><p className="mb-4 text-sm text-muted-foreground">{selected?.data.description}</p><Streamdown>{selected?.data.instructions||""}</Streamdown><Button className="mt-5" disabled={blocked||!connected||!!busy||sending||waiting||!!draft||!!generating} onClick={()=>selected&&void install(selected)}>安装到本地</Button></Drawer></section>;
}
