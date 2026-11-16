import {test} from "node:test";
import assert from "node:assert/strict";
import type {fetch as sourceFetch} from "undici";
import {fetchSourceJson,isPublicAddress,normalizePrompts,publicAddresses,sourceUrl} from "../src/prompt-sync.js";
import {cleanLogText,readUsage} from "../../shared/ai-log.js";

test("source destinations reject loopback, private, mapped, metadata and non-HTTP URLs",()=>{
    for(const address of ["127.0.0.1","0.0.0.0","10.0.0.1","172.16.0.1","192.168.1.1","169.254.169.254","100.100.100.200","168.63.129.16","::ffff:168.63.129.16","::1","::ffff:127.0.0.1","fd00:ec2::254","fe80::1","224.0.0.1"]){
        assert.equal(isPublicAddress(address),false,address);
        const host=address.includes(":")?`[${address}]`:address;
        assert.throws(()=>sourceUrl(`http://${host}/prompts.json`));
    }
    for(const url of ["file:///etc/passwd","http://user:password@example.com/","http://localhost/a","http://test.localhost/","http://2130706433/"])assert.throws(()=>sourceUrl(url));
    assert.equal(sourceUrl("https://example.com/prompts.json").hostname,"example.com");
    assert.equal(isPublicAddress("1.1.1.1"),true);
    assert.throws(()=>publicAddresses([{address:"1.1.1.1",family:4},{address:"10.0.0.1",family:4}]));
    assert.throws(()=>publicAddresses([]));
});

test("each redirect target is validated before another request, loops are rejected",async()=>{
    const calls:string[]=[];
    const redirect=(location:string)=>(async(url:unknown)=>{calls.push(String(url));return new Response(null,{status:302,headers:{location}});}) as typeof sourceFetch;
    await assert.rejects(()=>fetchSourceJson("https://example.com/start",undefined,redirect("http://169.254.169.254/latest/meta-data")));
    assert.equal(calls.length,1);
    calls.length=0;
    await assert.rejects(()=>fetchSourceJson("https://example.com/start",undefined,redirect("/start")));
    assert.equal(calls.length,1);
});

test("source parsing requires stable unique IDs and preserves relative public media URLs",()=>{
    const item={id:"stable",title:"测试",prompt:"正文",referenceImageUrls:["./image.png","javascript:alert(1)"]};
    assert.equal(normalizePrompts([item],"https://example.com/list.json")[0].data.referenceImageUrls[0],"https://example.com/image.png");
    assert.equal(normalizePrompts([item],"https://example.com/list.json")[0].data.referenceImageUrls.length,1);
    assert.throws(()=>normalizePrompts([{title:"missing-id",prompt:"正文"}],"https://example.com"));
    assert.throws(()=>normalizePrompts([item,item],"https://example.com"));
});

test("call logs redact credentials, signed query strings and base64; missing usage stays unknown",()=>{
    const text=cleanLogText("key=private-value Bearer bearer-secret sk-another-secret https://example.com/image?key=hidden#token data:image/png;base64,AAAA",["private-value"]);
    for(const value of ["private-value","bearer-secret","sk-another-secret","key=hidden","#token","base64,AAAA"])assert.ok(!text.includes(value),value);
    assert.equal(readUsage({}),null);
    assert.deepEqual(readUsage({usage:{prompt_tokens:0}}),{inputTokens:0,outputTokens:null,totalTokens:null});
    assert.deepEqual(readUsage({usageMetadata:{promptTokenCount:5,candidatesTokenCount:2,totalTokenCount:8}}),{inputTokens:5,outputTokens:2,totalTokens:8});
});
