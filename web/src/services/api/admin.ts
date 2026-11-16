import {cloudRequest} from "./cloud";
import {serializeApiParams,type ApiParams} from "./request";
import type {WorkflowDocument} from "../../../../shared/tutorial-workflow";

export type ResourceKind = "prompts"|"tutorials"|"skills"|"assets";
export type LibraryData = {
    title:string;description:string;coverUrl:string;tags:string[];category:string;
    prompt?:string;referenceImageUrls?:string[];author?:string;sourceUrl?:string;
    format?:"markdown"|"link"|"workflow";content?:string;href?:string;
    workflow?:WorkflowDocument;workflowSummary?:{nodeCount:number;connectionCount:number};
    name?:string;instructions?:string;defaultPrompt?:string;
    assetKind?:"text"|"image"|"video";mediaId?:string;width?:number;height?:number;bytes?:number;mimeType?:string;
};
export type LibraryItem = {id:string;kind:ResourceKind;data:LibraryData;published:boolean;position:number;sourceId:string|null;remotePresent:boolean;revision:number;createdAt:string;updatedAt:string};
export type LibraryList = {items:LibraryItem[];total:number;tags:string[];categories:string[]};
export type SiteSettings = {siteName:string;description:string;logoUrl:string;announcement:string;hidePrivateChannels:boolean;userCloudStorageEnabled:boolean;publicContent:Record<ResourceKind,boolean>;defaultStorageBytes:number;promptSyncMinutes:0|30|60|360|1440};
export type PublicSettings = Pick<SiteSettings,"siteName"|"description"|"logoUrl"|"announcement"|"publicContent"|"hidePrivateChannels"|"userCloudStorageEnabled">;
export type PromptSourceRecord = {id:string;name:string;url:string;homepage:string;enabled:boolean;revision:number;count:number;last_error:string;last_success_at:string|null;last_attempt_at:string|null};
export type AdminUser = {id:string;profile:{username:string;displayName:string;displayId?:string;avatarUrl?:string;role?:number;points?:number};enabled:boolean;note:string;storage_bytes:string|null;usedBytes:number;quotaBytes:number;created_at:string;last_login_at:string|null;profile_updated_at:string|null};
export type AiLog = {id:string;userId:string;user:AdminUser["profile"];createdAt:string;operation:string;model:string;status:string;startedAt:string;finishedAt:string|null;inputText?:string;outputText?:string;error:string;parameters:Record<string,unknown>;media:{inputCount:number;outputCount:number;inputTypes:string[];outputType:string};usage:{inputTokens:number|null;outputTokens:number|null;totalTokens:number|null};cost:null};
export const adminRequest = <T>(path:string,body?:unknown,method?:string,signal?:AbortSignal)=>cloudRequest<T>(`/admin${path}`,body,method,signal);
export const queryPath = (path:string,params:ApiParams={})=>`${path}?${serializeApiParams(params)}`;
export const fetchLibrary = (kind:ResourceKind,params:ApiParams={})=>cloudRequest<LibraryList>(queryPath(`/library/${kind}`,params));
export const fetchLibraryItem = (kind:ResourceKind,id:string,signal?:AbortSignal)=>cloudRequest<LibraryItem>(`/library/${kind}/${encodeURIComponent(id)}`,undefined,"GET",signal);
export const fetchAdminTutorial = (id:string,signal?:AbortSignal)=>adminRequest<LibraryItem>(`/tutorials/${encodeURIComponent(id)}`,undefined,"GET",signal);
export const fetchAdminWorkflows = (params:ApiParams={},signal?:AbortSignal)=>adminRequest<LibraryList>(queryPath("/tutorials",{...params,format:"workflow"}),undefined,"GET",signal);
export const fetchPublicSettings = ()=>cloudRequest<PublicSettings>("/library/settings");

export async function uploadPublicFile(file:File,signal?:AbortSignal){
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer())),value=>value.toString(16).padStart(2,"0")).join("");
    const {id,upload}=await adminRequest<{id:string;upload:{url:string;fields:Record<string,string>}}>("/media/uploads",{bytes:file.size,mimeType:file.type,sha256:hash},"POST",signal);
    const data=new FormData();for(const [key,value] of Object.entries(upload.fields))data.append(key,value);data.append("file",file);
    const response=await fetch(upload.url,{method:"POST",body:data,signal});
    if(!response.ok)throw new Error("素材上传失败");
    return {...await adminRequest<{id:string;url:string;bytes:number;mimeType:string}>(`/media/${id}/complete`,{},"POST",signal),sha256:hash};
}

export async function downloadPublicMedia(id:string,kind:"image"|"video"){
    const response=await fetch(`/api/library/media/${encodeURIComponent(id)}`,{cache:"no-store"});
    if(!response.ok)throw new Error("公共媒体已下架或下载失败");
    const blob=await response.blob();
    if(!blob.type.startsWith(`${kind}/`))throw new Error("公共媒体类型不匹配");
    return blob;
}
