import {cloudRequest} from "./cloud";
import {useUserStore} from "@/stores/use-user-store";
import {resolveModelRequestConfig,type AiConfig} from "@/stores/use-config-store";
import {cleanLogText,readUsage,type Usage} from "../../../../shared/ai-log";
export type CallRecord = {
    id:string;accountId:string;operation:"image"|"edit"|"text"|"video"|"audio";model:string;
    status:"running"|"success"|"error"|"cancelled";startedAt:string;finishedAt:string|null;
    inputText:string;outputText:string;error:string;parameters:Record<string,string|number|boolean|null>;
    media:{inputCount:number;outputCount:number;inputTypes:Array<"image"|"video"|"audio">;outputType:"image"|"video"|"audio"|"text"};usage:Usage;
};
export type UsageObserver = (payload:unknown,add?:boolean)=>void;
function secrets(config:AiConfig){return [config.apiKey,...config.channels.map(channel=>channel.apiKey)];}
export function sendCall(record:CallRecord|null){
    if(!record||record.accountId!==useUserStore.getState().user?.id)return;
    // A detached report cannot change the result of a browser-direct model request.
    try{void cloudRequest("/ai-events",record).catch(()=>undefined);}catch{/* Reporting is best effort. */}
}
export function beginCall(config:AiConfig,operation:CallRecord["operation"],inputText:string,inputCount=0,inputTypes:CallRecord["media"]["inputTypes"]=inputCount?["image"]:[]):CallRecord|null{
    try{
    const accountId=useUserStore.getState().user?.id;if(!accountId)return null;
    const key=operation==="audio"?config.audioModel:operation==="video"?config.videoModel:operation==="text"?config.textModel:config.imageModel;
    const resolved=resolveModelRequestConfig(config,config.model||key);
    const record:CallRecord={id:crypto.randomUUID(),accountId,operation,model:cleanLogText(resolved.model,secrets(config)),status:"running",startedAt:new Date().toISOString(),finishedAt:null,inputText:cleanLogText(inputText,secrets(config)),outputText:"",error:"",parameters:{size:config.size,quality:config.quality,count:config.count,seconds:config.videoSeconds,resolution:config.vquality,voice:config.audioVoice,format:config.audioFormat,speed:config.audioSpeed,reasoningEffort:config.reasoningEffort,mode:config.videoMode,generateAudio:config.videoGenerateAudio,watermark:config.videoWatermark},media:{inputCount,outputCount:0,inputTypes,outputType:operation==="edit"?"image":operation},usage:{inputTokens:null,outputTokens:null,totalTokens:null}};
    for(const key of Object.keys(record.parameters))if(typeof record.parameters[key]==="string")record.parameters[key]=cleanLogText(record.parameters[key] as string,secrets(config));
    sendCall(record);return record;
    }catch{return null;}
}
export function observeCall(record:CallRecord|null):UsageObserver{
    const missing=new Set<keyof Usage>();
    return (payload,add=false)=>{if(!record)return;const usage=readUsage(payload);if(!usage&&!add)return;
        for(const key of ["inputTokens","outputTokens","totalTokens"] as const){
            if(add){if(usage?.[key]==null)missing.add(key);record.usage[key]=missing.has(key)?null:(record.usage[key]??0)+(usage?.[key]??0);}
            else if(usage?.[key]!=null)record.usage[key]=usage[key];
        }
    };
}
export function finishCall(record:CallRecord|null,config:AiConfig,status:Exclude<CallRecord["status"],"running">,outputText="",outputCount=0,error?:unknown){
    if(!record||record.status!=="running")return;
    record.status=status;record.finishedAt=new Date().toISOString();record.outputText=cleanLogText(outputText,secrets(config));record.media.outputCount=outputCount;record.error=error?cleanLogText(error instanceof Error?error.message:String(error),secrets(config)):"";sendCall(record);
}
export async function loggedCall<T>(config:AiConfig,operation:CallRecord["operation"],inputText:string,inputCount:number,signal:AbortSignal|undefined,run:(observe:UsageObserver)=>Promise<T>,output:(result:T)=>{text?:string;count?:number}){
    const record=beginCall(config,operation,inputText,inputCount);
    try{const result=await run(observeCall(record));const value=output(result);finishCall(record,config,"success",value.text,value.count);return result;}
    catch(error){finishCall(record,config,signal?.aborted?"cancelled":"error","",0,error);throw error;}
}
