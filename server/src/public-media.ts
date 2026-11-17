import {randomUUID} from "node:crypto";
import type {FastifyInstance,FastifyRequest} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import type {Config} from "./config.js";
import type {Session} from "./auth.js";
import {transaction} from "./db.js";
import {audit,fail,publicCondition,readSettings} from "./management.js";
import {chooseWritePool,clientFor,objectKey} from "./storage/pools.js";
import {verifyObject} from "./storage/provider.js";

export function publicMediaRoutes(app:FastifyInstance,pool:Pool,config:Config,requireAdmin:(request:FastifyRequest)=>Promise<Session>){
    app.post("/api/admin/media/uploads",async(request)=>{
        const actor=await requireAdmin(request);
        const input=z.object({bytes:z.number().int().positive().max(config.MAX_MEDIA_BYTES),mimeType:z.string().regex(/^(image|video|audio)\//),sha256:z.string().regex(/^[a-f\d]{64}$/)}).parse(request.body);
        const id=randomUUID();
        return transaction(pool,async db=>{
            const selected=await chooseWritePool(db),key=objectKey(selected,`public/${id}`);
            const client=await clientFor(db,config,selected.id);
            try {
                const upload=await client.upload(key,input,config.MEDIA_URL_SECONDS);
                await db.query("INSERT INTO canvas_public_media(id,object_key,bytes,mime_type,sha256,expires_at,pool_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,key,input.bytes,input.mimeType,input.sha256,new Date(Date.now()+config.MEDIA_URL_SECONDS*1000),selected.id]);
                await audit(db,actor.userId,"media.upload",id,{bytes:input.bytes,mimeType:input.mimeType});
                return {id,upload};
            } finally {client.close();}
        });
    });
    app.post("/api/admin/media/:id/complete",async(request)=>{
        const actor = await requireAdmin(request);
        const {id}=z.object({id:z.string()}).parse(request.params);
        return transaction(pool,async db=>{
            const item=(await db.query("SELECT * FROM canvas_public_media WHERE id=$1 AND (ready OR expires_at>now()) FOR UPDATE",[id])).rows[0];
            if(!item) fail(404,"上传不存在或已过期");
            const client=await clientFor(db,config,item.pool_id);
            try {await verifyObject(client,item.object_key,{bytes:Number(item.bytes),sha256:item.sha256});} finally {client.close();}
            await db.query("UPDATE canvas_public_media SET ready=true WHERE id=$1",[id]);
            await audit(db,actor.userId,"media.complete",id,{bytes:Number(item.bytes),mimeType:item.mime_type});
            return {id,url:`/api/library/media/${id}`,bytes:Number(item.bytes),mimeType:item.mime_type};
        });
    });
    app.get("/api/library/media/:id",async(request,reply)=>{
        const {id}=z.object({id:z.string()}).parse(request.params);
        const settings=await readSettings(pool,config);
        const path=`/api/library/media/${id}`;
        const enabled=Object.entries(settings.publicContent).filter(([,value])=>value).map(([kind])=>kind);
        const published=await pool.query(`SELECT 1 FROM canvas_library l WHERE ${publicCondition} AND l.kind=ANY($3::text[]) AND ((l.remote_data||l.data)->>'mediaId'=$1 OR (l.remote_data||l.data)->>'coverUrl'=$2 OR (l.kind='tutorials' AND (l.remote_data||l.data)->>'format'='workflow' AND (l.remote_data||l.data)->'workflow'->'media' @> jsonb_build_array(jsonb_build_object('mediaId',$1::text))))`,[id,path,enabled]);
        if(!published.rowCount&&settings.logoUrl!==path) await requireAdmin(request);
        return transaction(pool,async db=>{
            const item=(await db.query("SELECT * FROM canvas_public_media WHERE id=$1 AND ready FOR SHARE",[id])).rows[0];
            if(!item) fail(404,"媒体不存在");
            const client=await clientFor(db,config,item.pool_id);
            let stream: Awaited<ReturnType<typeof client.read>>;
            try { stream = await client.read(item.object_key); } catch (error) { client.close(); throw error; }
            let released = false;
            const release = () => { if (!released) { released = true; client.close(); } };
            stream.once("end", release).once("error", release);
            reply.raw.once("close", release);
            return reply.type(item.mime_type).header("Content-Length", String(item.bytes)).header("Cache-Control", "private, max-age=600").send(stream);
        });
    });
}
