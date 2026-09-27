import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIProtection} from '../fetch.mjs';
import {quotaHash} from '../quota.mjs';
const property='11111111-1111-4111-8111-111111111111';
const secret='x'.repeat(32);
async function server(t, handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return `http://127.0.0.1:${s.address().port}`;}
const base=url=>({webdecoyUrl:url,webdecoyKey:'fixture',propertyId:property,subjectSecret:secret,scopeId:'test',resolveClientIP:()=>null,onObservation:()=>{},reportToWebDecoy:false});
for(const mode of ['observe','enforce'])for(const failureMode of ['open','closed'])for(const outage of [false,true]){
 test(`quota ${mode}/${failureMode}/outage=${outage}`,async t=>{
  let calls=0;
  const url=await server(t,async(req,res)=>{
   calls++;assert.equal(req.url,'/api/v1/sdk/ai-abuse/quota');assert.equal(req.headers['x-webdecoy-property-id'],property);
   let raw='';for await(const b of req)raw+=b;
   assert.ok(!raw.includes('private-account'));assert.ok(!raw.includes('private-prompt'));
   const p=JSON.parse(raw);assert.equal(p.subject,quotaHash(secret,'webdecoy.account-quota.v1',property,'chat_v1','account','private-account'));
   res.writeHead(outage?503:200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({schema:1,allowed:false,reason:'account_quota_exceeded',remaining:0,retry_after_seconds:30,reset_at:2000000000}));
  });
  const protect=createAIProtection({...base(url),protectionMode:'observe',accountQuota:{ruleId:'chat_v1',limit:2,windowSeconds:60,mode,failureMode,subject:ctx=>({accountId:ctx.accountId})}});
  let invoked=false;const result=await protect(new Request('https://owned.test/chat',{method:'POST',headers:{'X-Account-ID':'forged','X-Forwarded-For':'192.0.2.2'},body:'private-prompt'}),()=>{invoked=true;return new Response('ok')},{accountId:'private-account',plan:'private-plan'});
  const deny=mode==='enforce'&&(!outage||failureMode==='closed');assert.equal(invoked,!deny);assert.equal(calls,1);
  assert.equal(result.status,deny?(outage?503:429):200);assert.equal(result.headers.get('Retry-After'),deny&&!outage?'30':null);await protect.flush();
 });
}
test('quota cancellation, invalid identity and malformed response do not create permits',async t=>{
 let calls=0;const url=await server(t,(req,res)=>{calls++;res.end('{"schema":1}')});
 const protect=createAIProtection({...base(url),accountQuota:{ruleId:'chat',limit:1,windowSeconds:60,mode:'enforce',failureMode:'closed',subject:ctx=>({accountId:ctx.accountId})}});
 const ctl=new AbortController();ctl.abort();await assert.rejects(protect.check(new Request('https://owned.test/chat',{signal:ctl.signal}),{accountId:'a'}));assert.equal(calls,0);
 const invalid=await protect.check(new Request('https://owned.test/chat'),{accountId:''});assert.equal(invalid.status,503);assert.equal(calls,0);
 const malformed=await protect.check(new Request('https://owned.test/chat'),{accountId:'a'});assert.equal(malformed.status,503);assert.equal(malformed.reason,'account_quota_unavailable');
});
test('quota-store timeout fails open; caller cancellation still prevents inference',async t=>{
 for(const cancelCaller of [false,true]){
  const ctl=new AbortController();
  const url=await server(t,async(req,res)=>{for await(const _ of req){};if(cancelCaller)ctl.abort();setTimeout(()=>res.end('{}'),80)});
  const protect=createAIProtection({...base(url),accountQuota:{ruleId:'chat',limit:1,windowSeconds:60,mode:'enforce',failureMode:'open',timeoutMs:30,subject:()=>({accountId:'server-account'})}});
  let invoked=false;const run=()=>protect(new Request('https://owned.test/chat',{signal:ctl.signal}),()=>{invoked=true;return new Response('ok')});
  if(cancelCaller){await assert.rejects(run());assert.equal(invoked,false)}else{assert.equal((await run()).status,200);assert.equal(invoked,true)}
  await protect.flush();
 }
});
