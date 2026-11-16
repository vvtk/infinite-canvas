import { cloudRequest } from "./cloud";
import { fetchLibrary, type LibraryItem } from "./admin";

export type Prompt = {
    id:string;title:string;prompt:string;description:string;coverUrl:string;referenceImageUrls:string[];tags:string[];
    preview:string;createdAt:string;updatedAt:string;author?:string;sourceUrl?:string;
    imageMode?:string;imageModel?:string;imageSize?:string;imageCount?:number;
    sourceId:string;category:string;githubUrl:string;
};
export const ALL_PROMPTS_OPTION = "all";
export type PublicPromptSource = {id:string;name:string;homepage:string;enabled:boolean};
export type PromptListResponse = {items:Prompt[];tags:string[];categories:string[];total:number};
export const fetchPublicPromptSources = () => cloudRequest<{items:PublicPromptSource[]}>("/library/prompt-sources");
function toPrompt(item:LibraryItem):Prompt {
    return {...item.data,id:item.id,prompt:item.data.prompt||"",referenceImageUrls:item.data.referenceImageUrls||[],preview:item.data.description||item.data.prompt||"",sourceId:item.sourceId||"site",githubUrl:item.data.sourceUrl||"",createdAt:item.createdAt,updatedAt:item.updatedAt};
}
export async function fetchPrompts({keyword="",tag=[],category=ALL_PROMPTS_OPTION,page=1,pageSize=20}:{keyword?:string;tag?:string[];category?:string;page?:number;pageSize?:number}={}):Promise<PromptListResponse>{
    const result=await fetchLibrary("prompts",{keyword,tag,category,page,pageSize});
    return {...result,items:result.items.map(toPrompt)};
}
export async function fetchSourcePrompts(sourceId:string):Promise<Prompt[]> {
    const items:Prompt[]=[];
    for(let page=1;;page++){
        const result=await fetchLibrary("prompts",{sourceId,page,pageSize:100});
        items.push(...result.items.map(toPrompt));
        if(!result.items.length||items.length>=result.total)return items;
    }
}
export function formatPromptDate(value:string,locale?:string){
    const date=new Date(value);
    return Number.isNaN(date.getTime())?"":new Intl.DateTimeFormat(locale,{year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}
