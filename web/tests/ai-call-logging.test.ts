import {afterAll,expect,test} from "bun:test";
const originalStorage=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
const originalFetch=globalThis.fetch;
const {defaultConfig}=await import("../src/stores/use-config-store");
const {useUserStore}=await import("../src/stores/use-user-store");
const {beginCall,finishCall,loggedCall,observeCall}=await import("../src/services/api/ai-events");
const config={...defaultConfig,apiKey:"fixture-private-key",model:"fixture::test-model",channels:[{id:"fixture",name:"Fixture",baseUrl:"https://example.com",apiKey:"fixture-private-key",apiFormat:"openai" as const,models:[{name:"test-model",capability:"image" as const}]}]};
const reports:any[]=[];
const user=(id:string)=>({id,username:id,displayName:id,avatarUrl:""});
function setup(){reports.length=0;useUserStore.getState().setUser(user("alice"));globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{reports.push(JSON.parse(String(init?.body)));return new Response("{}",{headers:{"content-type":"application/json"}});}) as typeof fetch;}
afterAll(()=>{globalThis.fetch=originalFetch;useUserStore.getState().clearSession();if(originalStorage)Object.defineProperty(globalThis,"localStorage",originalStorage);else Reflect.deleteProperty(globalThis,"localStorage");});
test("a video-style record shares one ID through repeated completion and preserves unknown usage",()=>{
    setup();const record=beginCall(config,"video","prompt fixture-private-key",1)!;
    observeCall(record)({usage:{input_tokens:0}});
    finishCall(record,config,"success","",1);finishCall(record,config,"error","",0,new Error("late poll"));
    expect(reports).toHaveLength(2);expect(reports[0].id).toBe(reports[1].id);expect(reports[1].usage.outputTokens).toBeNull();expect(reports[1].usage.inputTokens).toBe(0);expect(JSON.stringify(reports)).not.toContain("fixture-private-key");
});
test("switching accounts or logging out cannot attribute a completion to another user",()=>{
    setup();const record=beginCall(config,"image","prompt")!;useUserStore.getState().setUser(user("bob"));finishCall(record,config,"success","",1);expect(reports).toHaveLength(1);
    const second=beginCall(config,"image","second")!;useUserStore.getState().clearSession();finishCall(second,config,"success","",1);expect(reports).toHaveLength(2);
});
test("failed reporting does not change generation result; cancellation is a terminal state",async()=>{
    setup();globalThis.fetch=(async()=>{throw new Error("offline");}) as typeof fetch;
    expect(await loggedCall(config,"audio","prompt",0,undefined,async()=>"generated",()=>({count:1}))).toBe("generated");
    setup();const controller=new AbortController();controller.abort();
    await expect(loggedCall(config,"text","prompt",0,controller.signal,async()=>{throw new DOMException("Aborted","AbortError");},()=>({}))).rejects.toThrow("Aborted");
    expect(reports.at(-1).status).toBe("cancelled");
});

test("partial multi-request usage remains unknown instead of implying a complete total",()=>{
    setup();const record=beginCall(config,"image","batch")!,observe=observeCall(record);
    observe({usage:{input_tokens:5,output_tokens:2,total_tokens:7}},true);
    observe({},true);finishCall(record,config,"success","",2);
    expect(reports.at(-1).usage).toEqual({inputTokens:null,outputTokens:null,totalTokens:null});
});
