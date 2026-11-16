import {useState} from "react";
import {NavLink,Navigate,Outlet,useLocation} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {Alert,Button,Drawer,Spin} from "antd";
import {BookOpen,FileText,HardDrive,Image,Menu,ScrollText,Settings2,Users,Workflow,Zap} from "lucide-react";
import {adminRequest} from "@/services/api/admin";
import {CloudError} from "@/services/api/cloud";
import {cn} from "@/lib/utils";
import {useUserStore} from "@/stores/use-user-store";
import {isSuperAdminRole} from "../../../shared/roles";

const menus=[
    {path:"users",label:"用户管理",icon:Users},{path:"compute-logs",label:"算力日志",icon:Zap},
    {path:"ai-logs",label:"AI 日志",icon:ScrollText},{path:"prompts",label:"提示词管理",icon:FileText},
    {path:"tutorials",label:"教程中心管理",icon:BookOpen},{path:"skills",label:"Skill 管理",icon:Workflow},
    {path:"assets",label:"素材库",icon:Image},{path:"settings",label:"系统配置",icon:Settings2},
    {path:"storage",label:"存储管理",icon:HardDrive},
    {path:"system-channel",label:"系统渠道配置",icon:Settings2},{path:"system-channel-models",label:"系统渠道模型",icon:Zap},
];
const superAdminPaths=new Set(["settings","storage","system-channel","system-channel-models"]);
export default function AdminLayout(){
    const [open,setOpen]=useState(false);
    const {pathname}=useLocation();
    const accountId=useUserStore(state=>state.user?.id);
    const role=useUserStore(state=>state.user?.role);
    const isSuperAdmin=isSuperAdminRole(role);
    const visibleMenus=menus.filter(menu=>isSuperAdmin||!superAdminPaths.has(menu.path));
    const permission=useQuery({queryKey:["admin","permission",accountId,pathname],queryFn:()=>adminRequest<{userId:string}>("/session"),retry:false,staleTime:0,refetchOnMount:"always",refetchOnWindowFocus:true});
    if(permission.isPending)return <div className="flex h-full items-center justify-center"><Spin/></div>;
    if(permission.error){
        if(permission.error instanceof CloudError&&[401,403].includes(permission.error.status))return <Navigate to="/" replace/>;
        return <div className="p-6"><Alert type="error" showIcon title="管理后台暂时不可用" description={permission.error.message} action={<Button onClick={()=>void permission.refetch()}>重试</Button>}/></div>;
    }
    const currentPath=pathname.replace(/^\/admin\/?/,"").split("/")[0];
    if(!isSuperAdmin&&superAdminPaths.has(currentPath))return <Navigate to="/admin/users" replace/>;
    const navigation=<nav className="space-y-1 p-3">{visibleMenus.map(({path,label,icon:Icon})=><NavLink key={path} to={`/admin/${path}`} onClick={()=>setOpen(false)} className={({isActive})=>cn("flex items-center gap-3 rounded-xl px-4 py-3 text-sm transition-colors",isActive?"bg-accent font-medium text-accent-foreground":"text-muted-foreground hover:bg-accent/60 hover:text-foreground")}><Icon className="size-4 shrink-0"/>{label}</NavLink>)}</nav>;
    return <div className="admin-shell flex h-full bg-background text-foreground">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-card md:block"><div className="px-7 pb-2 pt-6 text-xs font-medium tracking-wider text-muted-foreground">管理后台</div>{navigation}</aside>
            <div className="flex min-w-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-border px-4 py-2 md:hidden"><Button type="text" icon={<Menu className="size-4"/>} onClick={()=>setOpen(true)} aria-label="打开管理菜单"/>{visibleMenus.find(menu=>pathname.endsWith(menu.path))?.label}</div><main className="min-h-0 flex-1 overflow-auto p-4 md:p-6 lg:p-8"><Outlet key={accountId}/></main></div>
        <Drawer title="管理后台" placement="left" open={open} onClose={()=>setOpen(false)} size="default">{navigation}</Drawer>
    </div>;
}
