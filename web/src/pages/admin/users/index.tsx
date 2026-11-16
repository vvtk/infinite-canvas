import {useState} from "react";
import {App,Alert,Avatar,Button,Drawer,Form,Input,InputNumber,Space,Switch,Table,Tag,Tooltip} from "antd";
import {LogOut,Pencil,RefreshCw,Search,UserRound} from "lucide-react";
import {adminRequest,type AdminUser} from "@/services/api/admin";
import {formatBytes} from "@/lib/image-utils";
import {useAdminList} from "../use-admin-list";
import {roleLabel,USER_ROLE} from "../../../../../shared/roles";

export default function AdminUsersPage(){
    const {modal}=App.useApp();
    const {keyword,setKeyword,search,query,refresh,mutate}=useAdminList<AdminUser>("/users");
    const [editing,setEditing]=useState<AdminUser|null>(null);
    const [saving,setSaving]=useState(false);
    const [form]=Form.useForm();
    const open=(user:AdminUser)=>{form.setFieldsValue({enabled:user.enabled,note:user.note,storageGiB:user.storage_bytes===null?null:Number(user.storage_bytes)/1024**3});setEditing(user);};
    const save=async()=>{const values=await form.validateFields();setSaving(true);try{if(await mutate(()=>adminRequest(`/users/${editing!.id}`,{enabled:values.enabled,note:values.note||"",storageBytes:values.storageGiB==null?null:Math.round(values.storageGiB*1024**3)},"PATCH")))setEditing(null);}finally{setSaving(false);}};
    return <div className="space-y-5">
        <section className="rounded-2xl bg-card p-5"><label className="mb-2 block text-sm font-medium">关键词</label><Space wrap><Input allowClear className="!w-80 max-w-full" placeholder="搜索用户名、昵称或用户 ID" value={keyword} onChange={event=>setKeyword(event.target.value)} onPressEnter={()=>search(keyword)}/><Button icon={<Search className="size-4"/>} onClick={()=>search(keyword)}>查询</Button><Button onClick={()=>{setKeyword("");search("");}}>重置</Button></Space></section>
        <section className="rounded-2xl bg-card p-5"><div className="mb-5 flex items-center justify-between"><h1 className="text-base font-semibold">用户列表 <span className="ml-2 text-xs font-normal text-muted-foreground">{query.data?.items.length??0} 人</span></h1><Button type="text" icon={<RefreshCw className="size-4"/>} onClick={()=>void refresh()} aria-label="刷新用户列表"/></div>
        {query.error?<Alert type="error" showIcon title={query.error.message} className="mb-4"/>:null}
        <Table<AdminUser> rowKey="id" dataSource={query.data?.items||[]} loading={query.isFetching} scroll={{x:1100}} pagination={{defaultPageSize:10,showSizeChanger:true,showTotal:total=>`共 ${total} 人`}} columns={[
            {title:"用户",key:"user",render:(_,user)=><div className="flex items-center gap-3"><Avatar src={user.profile.avatarUrl} icon={<UserRound className="size-4"/>}/><div><div className="font-medium">{user.profile.displayName||user.profile.username}</div><div className="text-xs text-muted-foreground">{user.profile.username} · {user.profile.displayId||user.id}</div></div></div>},
            {title:"角色",render:(_,user)=><Tag color={user.profile.role===USER_ROLE.SUPER_ADMIN?"gold":user.profile.role===USER_ROLE.ADMIN?"blue":undefined}>{roleLabel(user.profile.role)}</Tag>},
            {title:"状态",render:(_,user)=><Tag color={user.enabled?"success":"error"}>{user.enabled?"正常":"禁用"}</Tag>},
            {title:"最近同步余额",render:(_,user)=><Tooltip title={user.profile_updated_at?`同步于 ${new Date(user.profile_updated_at).toLocaleString()}`:"尚未同步"}>{user.profile.points?.toLocaleString()??"—"}</Tooltip>},
            {title:"云存储",render:(_,user)=><span className="text-xs tabular-nums">{user.usedBytes===0?"0 B":formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}</span>},
            {title:"最近登录",render:(_,user)=>user.last_login_at?new Date(user.last_login_at).toLocaleString():"—"},
            {title:"操作",render:(_,user)=><Space><Button type="text" icon={<Pencil className="size-4"/>} onClick={()=>open(user)} aria-label="编辑用户"/><Button type="text" icon={<LogOut className="size-4"/>} aria-label="清除用户会话" onClick={()=>modal.confirm({title:"清除此用户的全部登录会话？",content:"该用户需要重新授权登录，已保存的数据保留。",onOk:async()=>{await mutate(()=>adminRequest(`/users/${user.id}/revoke-sessions`,{}));}})}/></Space>},
        ]}/></section>
        <Drawer title="编辑本站用户" open={!!editing} onClose={()=>setEditing(null)} extra={<Button type="primary" loading={saving} onClick={()=>void save()}>保存</Button>}>
            <Form form={form} layout="vertical"><Form.Item label="允许访问本站" name="enabled" valuePropName="checked"><Switch/></Form.Item><Form.Item label="管理员备注" name="note"><Input.TextArea rows={4}/></Form.Item><Form.Item label="个人云存储额度（GiB）" name="storageGiB" extra="留空使用系统默认额度。降低额度保留已有数据，超额后不能增加云存储占用。" rules={[{validator:(_,value)=>value==null||value>0?Promise.resolve():Promise.reject(new Error("额度必须大于 0"))}]}><InputNumber className="!w-full" placeholder="使用系统默认值"/></Form.Item></Form>
        </Drawer>
    </div>;
}
