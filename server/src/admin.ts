import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Session } from "./auth.js";
import { transaction } from "./db.js";
import { audit, fail, readSettings, settingsSchema, storageQuota, storageUsage } from "./management.js";

import {cleanLogText,logParameterKeys} from "../../shared/ai-log.js";

type Guard = (request:FastifyRequest) => Promise<Session>;
export function adminRoutes(app:FastifyInstance,pool:Pool,config:Config,requireAdmin:Guard,requireSuperAdmin:Guard,requireSession:Guard,reschedule:()=>Promise<void>) {
    app.get("/api/admin/session",async(request) => { const current=await requireAdmin(request); return {userId:current.userId}; });
    app.get("/api/admin/users",async(request) => {
        await requireAdmin(request);
        const {keyword=""}=request.query as {keyword?:string};
        const rows=(await pool.query("SELECT id,profile,enabled,note,storage_bytes,created_at,last_login_at,profile_updated_at FROM canvas_users WHERE profile::text ILIKE $1 ORDER BY created_at DESC",["%"+keyword+"%"])).rows;
        return {items:await Promise.all(rows.map(async(row)=>({...row,usedBytes:await storageUsage(pool,row.id),quotaBytes:await storageQuota(pool,config,row.id)})))};
    });
    app.patch("/api/admin/users/:id",async(request)=>{
        const actor=await requireAdmin(request);
        const {id}=z.object({id:z.string()}).parse(request.params);
        const input=z.object({enabled:z.boolean(),note:z.string(),storageBytes:z.number().int().positive().safe().nullable()}).parse(request.body);
        if(id===actor.userId&&!input.enabled) fail(400,"不能禁用当前管理员");
        await transaction(pool,async(db)=>{
            const row=(await db.query("UPDATE canvas_users SET enabled=$2,note=$3,storage_bytes=$4 WHERE id=$1 RETURNING id",[id,input.enabled,input.note,input.storageBytes])).rows[0];
            if(!row) fail(404,"用户不存在");
            if(!input.enabled) await db.query("DELETE FROM canvas_sessions WHERE user_id=$1",[id]);
            await audit(db,actor.userId,"user.update",id,input);
        });
        return {success:true};
    });
    app.post("/api/admin/users/:id/revoke-sessions",async(request)=>{
        const actor=await requireAdmin(request);
        const {id}=z.object({id:z.string()}).parse(request.params);
        await transaction(pool,async(db)=>{
            if(!(await db.query("SELECT id FROM canvas_users WHERE id=$1",[id])).rowCount) fail(404,"用户不存在");
            await db.query("DELETE FROM canvas_sessions WHERE user_id=$1",[id]);
            await audit(db,actor.userId,"user.revoke-sessions",id);
        });
        return {success:true};
    });
    app.get("/api/admin/settings",async(request)=>{
        await requireSuperAdmin(request);
        const row=(await pool.query("SELECT revision FROM canvas_site_settings WHERE id=true")).rows[0];
        return {data:await readSettings(pool,config),revision:Number(row.revision)};
    });
    app.patch("/api/admin/settings",async(request)=>{
        const actor=await requireSuperAdmin(request);
        const {data,revision}=z.object({data:settingsSchema,revision:z.number().int().positive()}).parse(request.body);
        if(data.logoUrl.startsWith("/api/library/media/")){
            const id=data.logoUrl.split("/").pop();
            if(!(await pool.query("SELECT 1 FROM canvas_public_media WHERE id=$1 AND ready AND mime_type LIKE 'image/%'",[id])).rowCount)fail(400,"Logo 图片尚未上传完成");
        }
        await transaction(pool,async(db)=>{
            if(!(await db.query("UPDATE canvas_site_settings SET data=$1,revision=revision+1 WHERE id=true AND revision=$2",[JSON.stringify(data),revision])).rowCount) fail(409,"配置已修改，请刷新后重试");
            await audit(db,actor.userId,"settings.update","site",data);
        });
        await reschedule();
        return {success:true};
    });
    app.get("/api/library/settings",async()=>{
        const {siteName,description,logoUrl,announcement,publicContent,hidePrivateChannels,userCloudStorageEnabled}=await readSettings(pool,config);
        return {siteName,description,logoUrl,announcement,publicContent,hidePrivateChannels,userCloudStorageEnabled};
    });
    app.get("/api/admin/audit",async(request)=>{
        await requireAdmin(request);
        return {items:(await pool.query("SELECT a.*,u.profile->>'username' AS username FROM canvas_admin_audit a LEFT JOIN canvas_users u ON u.id=a.actor_id ORDER BY a.created_at DESC")).rows};
    });
    const requestSchema=z.object({
        id:z.string().min(1),accountId:z.string().min(1),operation:z.enum(["image","edit","text","video","audio"]),model:z.string(),
        status:z.enum(["running","success","error","cancelled"]),startedAt:z.iso.datetime(),finishedAt:z.iso.datetime().nullable(),
        inputText:z.string(),outputText:z.string(),error:z.string(),
        parameters:z.partialRecord(z.enum(logParameterKeys),z.union([z.string(),z.number(),z.boolean(),z.null()])),
        media:z.object({inputCount:z.number().int().nonnegative(),outputCount:z.number().int().nonnegative(),inputTypes:z.array(z.enum(["image","video","audio"])),outputType:z.enum(["image","video","audio","text"])}),
        usage:z.object({inputTokens:z.number().nonnegative().nullable(),outputTokens:z.number().nonnegative().nullable(),totalTokens:z.number().nonnegative().nullable()}),
    });
    app.post("/api/ai-events",async(request)=>{
        const current=await requireSession(request);
        const input=requestSchema.parse(request.body);
        input.startedAt=new Date(input.startedAt).toISOString();
        if(input.finishedAt)input.finishedAt=new Date(input.finishedAt).toISOString();
        for(const key of ["inputText","outputText","error","model"] as const)input[key]=cleanLogText(input[key]);
        for(const key of logParameterKeys)if(typeof input.parameters[key]==="string")input.parameters[key]=cleanLogText(input.parameters[key] as string);
        if(current.userId!==input.accountId) fail(403,"调用记录与当前账号不匹配");
        await pool.query("INSERT INTO canvas_ai_requests(user_id,id,data) VALUES($1,$2,$3) ON CONFLICT(user_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now() WHERE canvas_ai_requests.data->>'status'='running'",[current.userId,input.id,JSON.stringify(input)]);
        return {success:true};
    });
    for(const name of ["compute-logs","ai-logs"]) app.get(`/api/admin/${name}`,async(request)=>{
        await requireAdmin(request);
        const filter=z.object({keyword:z.string().default(""),model:z.string().default(""),status:z.string().default(""),from:z.iso.datetime().optional(),to:z.iso.datetime().optional()}).parse(request.query);
        const rows=(await pool.query("SELECT r.*,u.profile FROM canvas_ai_requests r JOIN canvas_users u ON u.id=r.user_id WHERE ($1='' OR u.profile::text ILIKE '%'||$1||'%' OR r.data->>'model' ILIKE '%'||$1||'%') AND ($2='' OR r.data->>'model'=$2) AND ($3='' OR r.data->>'status'=$3) AND ($4::text IS NULL OR (r.data->>'startedAt') >= $4) AND ($5::text IS NULL OR (r.data->>'startedAt') <= $5) ORDER BY (r.data->>'startedAt') DESC",[filter.keyword,filter.model,filter.status,filter.from?new Date(filter.from).toISOString():null,filter.to?new Date(filter.to).toISOString():null])).rows;
        return {items:rows.map(row=>({id:row.id,userId:row.user_id,user:row.profile,createdAt:row.created_at,...row.data,...(name==="compute-logs"?{inputText:undefined,outputText:undefined}:{}),cost:null}))};
    });
}
