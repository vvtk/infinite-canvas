export const logParameterKeys = ["size","quality","count","seconds","resolution","voice","format","speed","reasoningEffort","mode","generateAudio","watermark"] as const;
export type Usage = {inputTokens:number|null;outputTokens:number|null;totalTokens:number|null};
export function cleanLogText(value:string,secrets:string[]=[]){
    let text=value;
    for(const secret of secrets)if(secret)text=text.split(secret).join("[已隐藏]");
    return text.replace(/data:[^\s,]*;base64,[A-Za-z0-9+/=]+/gi,"[媒体]")
        .replace(/https?:\/\/[^\s<>"']+/gi,url=>{try{const parsed=new URL(url);parsed.username="";parsed.password="";parsed.search="";parsed.hash="";return parsed.href;}catch{return "[地址]";}})
        .replace(/Bearer\s+[^\s"',;]+/gi,"Bearer [已隐藏]").replace(/sk-[A-Za-z0-9_-]+/g,"[已隐藏]")
        .replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,"$1[已隐藏]");
}
export function readUsage(value:unknown):Usage|null{
    if(!value||typeof value!=="object")return null;
    const root=value as Record<string,unknown>;
    const usage=(root.usage||root.usageMetadata) as Record<string,unknown>|undefined;
    if(!usage||typeof usage!=="object")return null;
    const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null;
    return {inputTokens:number(usage.input_tokens??usage.prompt_tokens??usage.promptTokenCount),outputTokens:number(usage.output_tokens??usage.completion_tokens??usage.candidatesTokenCount),totalTokens:number(usage.total_tokens??usage.totalTokenCount)};
}
