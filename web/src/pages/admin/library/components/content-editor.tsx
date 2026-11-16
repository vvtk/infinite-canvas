import {useEffect,useState} from "react";
import {useNavigate} from "react-router-dom";
import {App,Button,Drawer,Form,Input,InputNumber,Select,Switch,Upload} from "antd";
import {Upload as UploadIcon} from "lucide-react";
import {Streamdown} from "streamdown";
import {uploadPublicFile,type LibraryItem,type ResourceKind} from "@/services/api/admin";

const names:Record<ResourceKind,string>={prompts:"提示词",tutorials:"教程",skills:"Skill",assets:"素材"};
export function ContentEditor({kind,item,open,onClose,onSave}:{kind:ResourceKind;item:LibraryItem|null;open:boolean;onClose:()=>void;onSave:(values:Record<string,any>)=>Promise<boolean>}){
    const {message}=App.useApp();
    const navigate=useNavigate();
    const [form]=Form.useForm();
    const [saving,setSaving]=useState(false);
    const [uploading,setUploading]=useState(false);
    const [preview,setPreview]=useState(false);
    const assetKind=Form.useWatch("assetKind",form)||"text";
    const format=Form.useWatch("format",form)||"markdown";
    const content=Form.useWatch("content",form)||"";
    const coverUrl=Form.useWatch("coverUrl",form);
    useEffect(()=>{if(open){form.resetFields();form.setFieldsValue({...item?.data,published:item?.published??false,position:item?.position??0,assetKind:item?.data.assetKind||"text",format:item?.data.format||"markdown"});setPreview(false);}},[form,item,open]);
    const upload=async(file:File,cover=false)=>{
        setUploading(true);
        try{
            const result=await uploadPublicFile(file);
            if(cover)form.setFieldValue("coverUrl",result.url);
            else{
                let width=0,height=0;
                if(file.type.startsWith("image/")){const image=await createImageBitmap(file);width=image.width;height=image.height;image.close();}
                else if(file.type.startsWith("video/")){const url=URL.createObjectURL(file);try{const video=document.createElement("video");await new Promise<void>((resolve,reject)=>{video.onloadedmetadata=()=>resolve();video.onerror=()=>reject(new Error("无法读取视频信息"));video.src=url;});width=video.videoWidth;height=video.videoHeight;video.src="";}finally{URL.revokeObjectURL(url);}}
                form.setFieldsValue({mediaId:result.id,width,height,bytes:result.bytes,mimeType:result.mimeType,...(!form.getFieldValue("coverUrl")&&assetKind==="image"?{coverUrl:result.url}:{})});
            }
            message.success("上传完成");
        }catch(error){message.error(error instanceof Error?error.message:"上传失败");}finally{setUploading(false);}
        return Upload.LIST_IGNORE;
    };
    const openWorkflow=()=>{const {title,description,coverUrl,tags,category,published,position}=form.getFieldsValue();navigate(item?`/canvas/workflow/${encodeURIComponent(item.id)}`:"/canvas/workflow/new",{state:{workflowData:{title,description,coverUrl,tags,category},workflowPublished:published,workflowPosition:position}});};
    const save=async()=>{if(kind==="tutorials"&&format==="workflow"){openWorkflow();return;}const values=await form.validateFields();setSaving(true);try{if(await onSave(values))onClose();}finally{setSaving(false);}};
    return <Drawer title={`${item?"编辑":"新增"}${names[kind]}`} size="large" open={open} onClose={onClose} extra={<Button type="primary" disabled={uploading} loading={saving} onClick={()=>void save()}>{kind==="tutorials"&&format==="workflow"?"编辑节点流程":"保存"}</Button>}>
        <Form form={form} layout="vertical"><Form.Item name="title" label="标题" rules={[{required:true,whitespace:true,message:"请输入标题"},...(kind==="skills"?[{max:64,message:"Skill 标题最多 64 个字符"}]:[])]}><Input/></Form.Item>
        <Form.Item name="description" label="说明" rules={kind==="skills"?[{required:true,whitespace:true,message:"请输入技能说明"},{max:1024,message:"技能说明最多 1024 个字符"},{pattern:/^[^<>]*$/,message:"技能说明不能包含尖括号"}]:[]}><Input.TextArea rows={2}/></Form.Item>
        <div className="grid grid-cols-2 gap-x-4"><Form.Item name="category" label="分类"><Input/></Form.Item><Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[",","，"]} placeholder="输入后按回车添加"/></Form.Item></div>
        <Form.Item name="coverUrl" label="封面地址"><Input placeholder="HTTP(S) 地址或上传封面"/></Form.Item><div className="mb-5 flex items-center gap-3"><Upload accept="image/*" showUploadList={false} beforeUpload={file=>upload(file,true)}><Button loading={uploading} icon={<UploadIcon className="size-4"/>}>上传封面</Button></Upload>{coverUrl?<img src={coverUrl} alt="封面预览" className="size-14 rounded-lg object-cover"/>:null}</div>
        {kind==="prompts"?<><Form.Item name="prompt" label="提示词正文" rules={[{required:true,whitespace:true,message:"请输入提示词"}]}><Input.TextArea autoSize={{minRows:8}}/></Form.Item><Form.Item name="referenceImageUrls" label="参考图地址"><Select mode="tags" placeholder="输入 HTTP(S) 地址后按回车"/></Form.Item><Form.Item name="author" label="作者"><Input/></Form.Item><Form.Item name="sourceUrl" label="原文地址"><Input/></Form.Item></>:null}
        {kind==="tutorials"?<><Form.Item name="format" label="教程形式"><Select options={[{value:"markdown",label:"Markdown 正文"},{value:"link",label:"教程链接"},{value:"workflow",label:"节点流程"}]}/></Form.Item>{format==="workflow"?<p className="mb-5 text-sm text-muted-foreground">进入全屏画布配置节点、连线和示例媒体，保存后返回教程管理。</p>:format==="link"?<Form.Item name="href" label="跳转地址" rules={[{required:true,message:"请输入链接"}]}><Input placeholder="站内路径或 HTTP(S) 地址"/></Form.Item>:<><Form.Item name="content" label="Markdown 正文" rules={[{required:true,whitespace:true,message:"请输入教程正文"}]}><Input.TextArea autoSize={{minRows:12}}/></Form.Item><Button type="text" onClick={()=>setPreview(!preview)}>{preview?"收起预览":"预览正文"}</Button>{preview?<div className="my-3 rounded-xl border border-border p-4"><Streamdown>{content}</Streamdown></div>:null}</>}</>:null}
        {kind==="skills"?<><Form.Item name="name" label="技能标识" extra="小写字母、数字和短横线；用于本地 Agent 的技能目录名。" rules={[{max:64,message:"技能标识最多 64 个字符"},{required:true,pattern:/^[a-z0-9]+(?:-[a-z0-9]+)*$/,message:"请输入有效的技能标识"}]}><Input/></Form.Item><Form.Item name="instructions" label="技能正文" rules={[{required:true,whitespace:true,message:"请输入技能正文"}]}><Input.TextArea autoSize={{minRows:12}}/></Form.Item><Form.Item name="defaultPrompt" label="默认提示词" extra="非空时需包含 $技能标识，例如 $my-skill。" rules={[{max:1024,message:"默认提示词最多 1024 个字符"}]}><Input.TextArea rows={3}/></Form.Item></>:null}
        {kind==="assets"?<><Form.Item name="assetKind" label="素材类型"><Select disabled={!!item} options={[{value:"text",label:"文本"},{value:"image",label:"图片"},{value:"video",label:"视频"}]}/></Form.Item>{assetKind==="text"?<Form.Item name="content" label="文本内容" rules={[{required:true,whitespace:true,message:"请输入文本"}]}><Input.TextArea autoSize={{minRows:8}}/></Form.Item>:<><Form.Item name="mediaId" label="媒体文件" rules={[{required:true,message:"请先上传媒体文件"}]}><Input readOnly placeholder="上传后自动填写"/></Form.Item><Upload accept={`${assetKind}/*`} showUploadList={false} beforeUpload={file=>upload(file)}><Button loading={uploading} icon={<UploadIcon className="size-4"/>}>上传{assetKind==="image"?"图片":"视频"}</Button></Upload>{["width","height","bytes","mimeType"].map(name=><Form.Item key={name} name={name} hidden><Input/></Form.Item>)}</>}</>:null}
        <div className="mt-6 grid grid-cols-2 gap-x-4"><Form.Item name="position" label="排序"><InputNumber className="!w-full"/></Form.Item><Form.Item name="published" label="发布到公共库" valuePropName="checked"><Switch/></Form.Item></div></Form>
    </Drawer>;
}
