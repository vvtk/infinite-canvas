import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { Agent, fetch } from "undici";
import ipaddr from "ipaddr.js";
import type { Pool } from "pg";
import { fail, httpUrl } from "./management.js";

export function isPublicAddress(address: string) {
    try { const parsed = ipaddr.process(address); return parsed.toString() !== "168.63.129.16" && parsed.range() === "unicast"; } catch { return false; }
}
export function sourceUrl(value: string) {
    const url = new URL(httpUrl.parse(value));
    const host = url.hostname.replace(/^\[|\]$/g,"");
    if (url.hash || host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost") || isIP(host) && !isPublicAddress(host)) fail(400,"来源必须为公开网络地址");
    return url;
}
export function publicAddresses(addresses:Array<{address:string;family:number}>){
    if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))fail(400,"来源地址不能指向内网");
    return addresses;
}
function createSourceAgent(){return new Agent({ connect: { lookup(host, options, callback) {
    lookup(host,{all:true}).then((addresses) => {
        publicAddresses(addresses);
        const family = typeof options === "object" ? options.family : 0;
        const choices = family ? addresses.filter((item) => item.family === Number(family)) : addresses;
        if (!choices.length) return callback(new Error("来源地址无法解析"),[],undefined);
        if (typeof options === "object" && options.all) callback(null,choices,undefined);
        else callback(null,choices[0].address,choices[0].family);
    }).catch((error) => callback(error,[],undefined));
} } });}
export async function fetchSourceJson(address: string, signal?: AbortSignal,request=fetch): Promise<unknown> {
    const sourceAgent=createSourceAgent();
    try {
    const visited = new Set<string>();
    let url = sourceUrl(address);
    while (true) {
        if (visited.has(url.href)) fail(400,"来源重定向循环");
        visited.add(url.href);
        const response = await request(url,{dispatcher:sourceAgent,redirect:"manual",signal});
        if ([301,302,303,307,308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) fail(400,"来源重定向地址无效");
            url = sourceUrl(new URL(location!,url).href);
            continue;
        }
        if (!response.ok) { await response.body?.cancel(); fail(502,`来源请求失败（${response.status}）`); }
        return await response.json();
    }
    }finally{await sourceAgent.close();}
}
function remoteUrl(value: unknown, base: string) {
    if (typeof value !== "string" || !value.trim()) return "";
    try { return httpUrl.parse(new URL(value,base).href); } catch { return ""; }
}
export function normalizePrompts(value: unknown, base: string) {
    if (!Array.isArray(value)) fail(400,"提示词来源必须为 JSON 数组");
    const ids = new Set<string>();
    return (value as unknown[]).map((entry) => {
        if (!entry || typeof entry !== "object") fail(400,"提示词条目格式无效");
        const item = entry as Record<string,unknown>;
        // Missing IDs are rejected rather than using positions that could overwrite another prompt after reordering.
        if (typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || !item.title.trim() || typeof item.prompt !== "string" || !item.prompt.trim()) fail(400,"每条提示词必须包含稳定的 id、标题和正文");
        const id = (item.id as string).trim();
        if (ids.has(id)) fail(400,"来源包含重复的提示词 ID");
        ids.add(id);
        return {id,data:{title:item.title,prompt:item.prompt,description:typeof item.description === "string" ? item.description : "",coverUrl:remoteUrl(item.coverUrl,base),referenceImageUrls:Array.isArray(item.referenceImageUrls) ? item.referenceImageUrls.map((url) => remoteUrl(url,base)).filter(Boolean) : [],tags:Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [],author:typeof item.author === "string" ? item.author : "",sourceUrl:remoteUrl(item.sourceUrl,base),category:""}};
    });
}
export async function syncSource(pool: Pool, id: string, signal?: AbortSignal,fetchJson=fetchSourceJson) {
    const lock = await pool.connect();
    let acquired = false;
    try {
        acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",["prompt-source:"+id])).rows[0].locked;
        if (!acquired) return {id,status:"running" as const};
        const source = (await lock.query("SELECT * FROM canvas_prompt_sources WHERE id=$1 AND NOT deleted",[id])).rows[0];
        if (!source) fail(404,"来源不存在");
        await lock.query("UPDATE canvas_prompt_sources SET last_attempt_at=now() WHERE id=$1",[id]);
        try {
            const items = normalizePrompts(await fetchJson(source.url,signal),source.url);
            await lock.query("BEGIN");
            try {
                const db=lock;
                const current = (await db.query("SELECT revision FROM canvas_prompt_sources WHERE id=$1 AND NOT deleted FOR UPDATE",[id])).rows[0];
                if (!current || Number(current.revision) !== Number(source.revision)) fail(409,"来源配置已修改，请重新同步");
                await db.query("UPDATE canvas_library SET remote_present=false WHERE source_id=$1",[id]);
                for (const item of items) await db.query("INSERT INTO canvas_library(id,kind,source_id,remote_id,remote_data,published) VALUES($1,'prompts',$2,$3,$4,true) ON CONFLICT(source_id,remote_id) DO UPDATE SET remote_data=EXCLUDED.remote_data,remote_present=true,updated_at=now(),revision=canvas_library.revision+1",[randomUUID(),id,item.id,JSON.stringify(item.data)]);
                await db.query("UPDATE canvas_prompt_sources SET last_success_at=now(),last_error='' WHERE id=$1",[id]);
                await lock.query("COMMIT");
            } catch(error){await lock.query("ROLLBACK");throw error;}
            return {id,status:"success" as const,count:items.length};
        } catch (error) {
            const message = error instanceof Error ? error.message : "同步失败";
            await lock.query("UPDATE canvas_prompt_sources SET last_error=$2 WHERE id=$1",[id,message]);
            return {id,status:"error" as const,error:message};
        }
    } finally {
        if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext($1))",["prompt-source:"+id]);
        lock.release();
    }
}
