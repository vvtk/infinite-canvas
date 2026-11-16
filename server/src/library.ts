import {randomUUID} from "node:crypto";
import type {FastifyInstance,FastifyRequest} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import type {Config} from "./config.js";
import type {Session} from "./auth.js";
import {DEFAULT_PROMPT_SOURCES} from "../../shared/prompt-sources.js";
import {transaction} from "./db.js";
import {audit,contentSchemas,fail,httpUrl,libraryItem,publicCondition,readSettings,resourceKinds,type ResourceKind} from "./management.js";
import {syncSource,sourceUrl} from "./prompt-sync.js";
import {workflowSummary} from "./tutorial-workflow.js";
import type {WorkflowDocument} from "../../shared/tutorial-workflow.js";

export async function libraryRoutes(app:FastifyInstance,pool:Pool,config:Config,requireAdmin:(request:FastifyRequest)=>Promise<Session>){
    await transaction(pool,async(db)=>{
        const settings=await readSettings(db,config);
        await db.query("INSERT INTO canvas_site_settings(id,data) VALUES(true,$1) ON CONFLICT DO NOTHING",[JSON.stringify(settings)]);
        for(const source of DEFAULT_PROMPT_SOURCES) await db.query("INSERT INTO canvas_prompt_sources(id,name,url,homepage) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[source.id,source.name,source.url,source.homepage]);
        for(const item of [{id:"tutorial-image",title:"AI制图标准流",href:"/prompts"},{id:"tutorial-video",title:"AI动画标准流",href:"/video"}]) await db.query("INSERT INTO canvas_library(id,kind,data,published) VALUES($1,'tutorials',$2,true) ON CONFLICT DO NOTHING",[item.id,JSON.stringify({title:item.title,href:item.href,format:"link",description:"",coverUrl:"",tags:[],category:"",content:""})]);
    });
    const shutdown=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let pending:Promise<unknown>|undefined;
    async function runScheduled(){
        const settings=await readSettings(pool,config);
        if(!settings.promptSyncMinutes||shutdown.signal.aborted)return;
        const due=(await pool.query("SELECT id FROM canvas_prompt_sources WHERE enabled AND NOT deleted AND (last_attempt_at IS NULL OR last_attempt_at<=now()-($1*interval '1 minute'))",[settings.promptSyncMinutes])).rows;
        await Promise.allSettled(due.map(row=>syncSource(pool,row.id,shutdown.signal)));
    }
    let syncMinutes=(await readSettings(pool,config)).promptSyncMinutes;
    async function reschedule(){
        clearTimeout(timer);
        try{syncMinutes=(await readSettings(pool,config)).promptSyncMinutes;}catch{/* Retain the configured cycle while the database is temporarily unavailable. */}
        if(shutdown.signal.aborted||!syncMinutes)return;
        timer=setTimeout(()=>{
            pending=runScheduled().catch(()=>undefined).finally(()=>{pending=undefined;if(!shutdown.signal.aborted)void reschedule().catch(()=>undefined);});
        },syncMinutes*60_000);
        timer.unref();
    }
    app.addHook("onReady",async()=>{pending=runScheduled().catch(()=>undefined).finally(()=>{pending=undefined;if(!shutdown.signal.aborted)void reschedule().catch(()=>undefined);});});
    app.addHook("onClose",async()=>{shutdown.abort();clearTimeout(timer);await pending;});
    const sourceSchema=z.object({name:z.string().trim().min(1),url:httpUrl,homepage:z.union([httpUrl,z.literal("")]).default(""),enabled:z.boolean()});
    app.get("/api/admin/prompt-sources",async(request)=>{
        await requireAdmin(request);
        return {items:(await pool.query("SELECT s.*,(SELECT COUNT(*)::int FROM canvas_library l WHERE l.source_id=s.id AND NOT l.deleted AND l.remote_present) AS count FROM canvas_prompt_sources s WHERE NOT s.deleted ORDER BY s.name")).rows};
    });
    app.post("/api/admin/prompt-sources",async(request)=>{
        const actor=await requireAdmin(request),input=sourceSchema.parse(request.body),id=randomUUID();
        sourceUrl(input.url);
        await transaction(pool,async(db)=>{await db.query("INSERT INTO canvas_prompt_sources(id,name,url,homepage,enabled) VALUES($1,$2,$3,$4,$5)",[id,input.name,input.url,input.homepage,input.enabled]);await audit(db,actor.userId,"source.create",id,{name:input.name});});
        await reschedule();return {id};
    });
    app.patch("/api/admin/prompt-sources/:id",async(request)=>{
        const actor=await requireAdmin(request),{id}=z.object({id:z.string()}).parse(request.params);
        const input=sourceSchema.extend({revision:z.number().int().positive()}).parse(request.body);
        sourceUrl(input.url);
        await transaction(pool,async(db)=>{
            if(!(await db.query("UPDATE canvas_prompt_sources SET name=$2,url=$3,homepage=$4,enabled=$5,revision=revision+1 WHERE id=$1 AND revision=$6 AND NOT deleted",[id,input.name,input.url,input.homepage,input.enabled,input.revision])).rowCount) fail(409,"来源已修改，请刷新后重试");
            await audit(db,actor.userId,"source.update",id,{name:input.name,enabled:input.enabled});
        });await reschedule();return {success:true};
    });
    app.delete("/api/admin/prompt-sources/:id",async(request)=>{
        const actor=await requireAdmin(request),{id}=z.object({id:z.string()}).parse(request.params);
        await transaction(pool,async(db)=>{await db.query("UPDATE canvas_prompt_sources SET deleted=true,enabled=false,revision=revision+1 WHERE id=$1",[id]);await audit(db,actor.userId,"source.delete",id);});
        await reschedule();return {success:true};
    });
    app.post("/api/admin/prompt-sources/:id/sync",async(request)=>{
        const actor=await requireAdmin(request),{id}=z.object({id:z.string()}).parse(request.params);
        const result=await syncSource(pool,id,shutdown.signal);await audit(pool,actor.userId,"source.sync",id,result);return result;
    });
    app.post("/api/admin/prompt-sources/sync",async(request)=>{
        const actor=await requireAdmin(request),sources=(await pool.query("SELECT id FROM canvas_prompt_sources WHERE enabled AND NOT deleted")).rows;
        const results=await Promise.all(sources.map(row=>syncSource(pool,row.id,shutdown.signal)));
        await audit(pool,actor.userId,"source.sync-all","sources",{results});return {results};
    });
    app.get("/api/library/prompt-sources",async()=>{
        if(!(await readSettings(pool,config)).publicContent.prompts) return {items:[]};
        const rows=(await pool.query("SELECT id,name,homepage FROM canvas_prompt_sources WHERE enabled AND NOT deleted ORDER BY name")).rows;
        return {items:[{id:"site",name:"本站提示词",homepage:""},...rows].map(row=>({...row,enabled:true}))};
    });
    async function list(kind:ResourceKind,query:unknown,admin:boolean){
        const filter=z.object({keyword:z.string().default(""),category:z.string().default(""),format:z.enum(["markdown","link","workflow"]).optional(),assetKind:z.enum(["text","image","video"]).optional(),tag:z.union([z.string(),z.array(z.string())]).default([]),sourceId:z.string().default(""),page:z.coerce.number().int().positive().default(1),pageSize:z.coerce.number().int().positive().default(20)}).parse(query);
        const settings=await readSettings(pool,config);
        if(!admin&&!settings.publicContent[kind]) return {items:[],total:0,tags:[],categories:[]};
        const rows=(await pool.query(`SELECT l.*,s.name AS source_name FROM canvas_library l LEFT JOIN canvas_prompt_sources s ON s.id=l.source_id WHERE l.kind=$1 AND ${admin?"NOT l.deleted":publicCondition} ORDER BY l.position,l.created_at DESC`,[kind])).rows;
        const all=rows.map(row=>{const item=libraryItem(row);if(kind==="prompts")item.data.category ||=row.source_name||"本站提示词";return item;});
        const base=all.filter(item=>(kind!=="tutorials"||!filter.format||item.data.format===filter.format)&&(!filter.sourceId||(item.sourceId||"site")===filter.sourceId)&&(!filter.category||filter.category==="all"||item.data.category===filter.category)&&(!filter.keyword||[item.data.title,item.data.description,item.data.prompt,item.data.content,item.data.instructions,item.data.name,...(item.data.tags||[])].join(" ").toLowerCase().includes(filter.keyword.toLowerCase())));
        const tags=(typeof filter.tag==="string"?[filter.tag]:filter.tag).filter(Boolean);
        const filtered=base.filter(item=>(kind!=="assets"||!filter.assetKind||item.data.assetKind===filter.assetKind)&&(!tags.length||tags.some(tag=>item.data.tags?.includes(tag))));
        return {items:filtered.slice((filter.page-1)*filter.pageSize,filter.page*filter.pageSize).map(item=>({...item,data:workflowSummary(item.data)})),total:filtered.length,tags:[...new Set(base.flatMap(item=>item.data.tags||[]))].sort(),categories:[...new Set(all.map(item=>item.data.category).filter(Boolean))].sort()};
    }
    app.get("/api/admin/tutorials/:id",async(request)=>{
        await requireAdmin(request);
        const {id}=z.object({id:z.string()}).parse(request.params);
        const row=(await pool.query("SELECT * FROM canvas_library WHERE id=$1 AND kind='tutorials' AND NOT deleted",[id])).rows[0];
        if(!row)fail(404,"教程不存在");
        return libraryItem(row);
    });
    for(const kind of resourceKinds){
        app.get(`/api/admin/${kind}`,async(request)=>{await requireAdmin(request);return list(kind,request.query,true);});
        app.get(`/api/library/${kind}`,async(request)=>list(kind,request.query,false));
        app.get(`/api/library/${kind}/:id`,async(request)=>{
            const {id}=z.object({id:z.string()}).parse(request.params);
            if(!(await readSettings(pool,config)).publicContent[kind]) fail(404,"内容未开放");
            const row=(await pool.query(`SELECT l.* FROM canvas_library l WHERE l.id=$1 AND l.kind=$2 AND ${publicCondition}`,[id,kind])).rows[0];
            if(!row)fail(404,"内容不存在或已下架");return libraryItem(row);
        });
        const inputSchema=z.object({data:contentSchemas[kind],published:z.boolean(),position:z.number().finite().default(0)});
        function parseInput<T>(schema:z.ZodType<T>,body:unknown):T {
            if(kind!=="tutorials")return schema.parse(body);
            const result=schema.safeParse(body);
            if(!result.success)fail(400,result.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join("；"));
            return result.data;
        }
        async function validateMedia(data:Record<string,unknown>){
            const ids=[data.mediaId,typeof data.coverUrl==="string"?data.coverUrl.match(/^\/api\/library\/media\/(.+)$/)?.[1]:undefined].filter(Boolean) as string[];
            for(const id of ids){const row=(await pool.query("SELECT * FROM canvas_public_media WHERE id=$1 AND ready",[id])).rows[0];if(!row)fail(400,"素材尚未上传完成");if(id!==data.mediaId&&!row.mime_type.startsWith("image/"))fail(400,"封面必须为图片");if(id===data.mediaId){if(!row.mime_type.startsWith(data.assetKind+"/"))fail(400,"媒体类型不匹配");data.bytes=Number(row.bytes);data.mimeType=row.mime_type;}}
            for(const media of (data.workflow as WorkflowDocument|undefined)?.media||[]){
                const row=(await pool.query("SELECT bytes,mime_type,sha256 FROM canvas_public_media WHERE id=$1 AND ready",[media.mediaId])).rows[0];
                if(!row||Number(row.bytes)!==media.bytes||row.mime_type!==media.mimeType||row.sha256!==media.sha256)fail(400,"流程素材未上传完成或内容不匹配");
            }
        }
        app.post(`/api/admin/${kind}`,async(request)=>{
            const actor=await requireAdmin(request),input=parseInput(inputSchema,request.body),id=randomUUID();
            await validateMedia(input.data);
            await transaction(pool,async(db)=>{await db.query("INSERT INTO canvas_library(id,kind,data,published,position) VALUES($1,$2,$3,$4,$5)",[id,kind,JSON.stringify(input.data),input.published,input.position]);await audit(db,actor.userId,kind+".create",id,{title:input.data.title,published:input.published});});return {id};
        });
        app.patch(`/api/admin/${kind}/:id`,async(request)=>{
            const actor=await requireAdmin(request),{id}=z.object({id:z.string()}).parse(request.params),input=parseInput(inputSchema.extend({revision:z.number().int().positive()}),request.body);
            await validateMedia(input.data);
            await transaction(pool,async(db)=>{
                const row=(await db.query("SELECT l.*,s.name AS source_name FROM canvas_library l LEFT JOIN canvas_prompt_sources s ON s.id=l.source_id WHERE l.id=$1 AND l.kind=$2 AND NOT l.deleted FOR UPDATE OF l",[id,kind])).rows[0];
                if(!row)fail(404,"内容不存在");if(Number(row.revision)!==input.revision)fail(409,"内容已更新，请刷新后编辑");
                if(row.source_id&&input.data.category===row.source_name)input.data.category="";
                const effective={...row.remote_data,...row.data};
                const data=row.source_id?{...row.data,...Object.fromEntries(Object.entries(input.data).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(effective[key])))}:input.data;
                await db.query("UPDATE canvas_library SET data=$2,published=$3,position=$4,revision=revision+1,updated_at=now() WHERE id=$1",[id,JSON.stringify(data),input.published,input.position]);await audit(db,actor.userId,kind+".update",id,{title:input.data.title,published:input.published});
            });return {success:true};
        });
        app.post(`/api/admin/${kind}/delete`,async(request)=>{
            const actor=await requireAdmin(request),{ids}=z.object({ids:z.array(z.string()).min(1)}).parse(request.body);
            await transaction(pool,async(db)=>{await db.query("UPDATE canvas_library SET deleted=true,published=false,revision=revision+1,updated_at=now() WHERE kind=$1 AND id=ANY($2::text[])",[kind,ids]);await audit(db,actor.userId,kind+".delete",kind,{ids});});return {success:true};
        });
    }
    return {reschedule};
}
