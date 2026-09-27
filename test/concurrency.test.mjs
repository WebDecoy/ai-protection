import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIProtection} from '../fetch.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,kind='complete'){
 let held=false,releases=0,renewals=0,starts=0;const tasks=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;assert.ok(!raw.includes('raw-account'));
  const p=JSON.parse(raw);if(kind==='outage'){res.writeHead(503);res.end();return}
  const result={schema:1,allowed:true,granted:true,reason:'concurrency_allowed',lease_id:'22222222-2222-4222-8222-222222222222',retry_after_seconds:0,valid_for_ms:6000};
  if(p.operation==='acquire'){if(held){result.allowed=false;result.granted=false;result.reason='concurrency_exceeded';result.retry_after_seconds=12}else held=true}
  if(p.operation==='renew'){renewals++;if(kind==='lost'){res.writeHead(503);res.end();return}result.reason='concurrency_renewed'}
  if(p.operation==='release'){releases++;held=false;result.granted=false;result.reason='concurrency_released'}
  res.end(JSON.stringify(result));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const p=createAIProtection({webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:'11111111-1111-4111-8111-111111111111',scopeId:'test',subjectSecret:'x'.repeat(32),resolveClientIP:()=>null,onObservation:()=>{},reportToWebDecoy:false,waitUntil:task=>tasks.push(task),concurrency:{ruleId:'chat',accountLimit:1,featureLimit:2,ttlSeconds:6,maxSeconds:12,mode:'enforce',failureMode:'closed',subject:c=>({accountId:c.accountId})}});
 const request=()=>new Request('https://owned.test/chat');const context={accountId:'raw-account'};
 return {p,request,context,tasks,started:()=>starts++,state:()=>({held,releases,renewals,starts})};
}
test('stream response is unchanged; capacity held until confirmed finished, denial never calls provider',async t=>{
 const f=await fixture(t);let done;const finished=new Promise(r=>done=r);const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));c.close()}}));
 const result=await f.p.concurrent(f.request(),()=>{f.started();return {response,finished}},f.context);assert.equal(result,response);assert.equal(f.state().releases,0);
 const denied=await f.p.concurrent(f.request(),()=>{throw Error('provider must not start')},f.context);assert.equal(denied.status,429);assert.equal(denied.headers.get('Retry-After'),'12');
 await pause(2100);assert.ok(f.state().renewals>=1);assert.equal(f.state().releases,0);
 done();await Promise.all(f.tasks);assert.equal(f.state().releases,1);assert.equal(f.state().starts,1);
});
test('lost heartbeat cancels provider signal and retains uncertain capacity',async t=>{
 const f=await fixture(t,'lost');let signal;
 await f.p.concurrent(f.request(),runtime=>{signal=runtime.signal;f.started();return {response:new Response('stream'),finished:new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}},f.context);
 await Promise.all(f.tasks);assert.equal(signal.aborted,true);assert.equal(f.state().releases,0);
});
test('caller disconnect and rejected completion do not claim a stopped upstream',async t=>{
 const f=await fixture(t);const ctl=new AbortController();let finish;
 await f.p.concurrent(new Request('https://owned.test/chat',{signal:ctl.signal}),()=>({response:new Response('ok'),finished:new Promise(r=>finish=r)}),f.context);
 ctl.abort();finish();await Promise.all(f.tasks);assert.equal(f.state().releases,0);
});
test('exceptions, invalid lifecycle and unavailable closed-state never reuse uncertain slots',async t=>{
 const f=await fixture(t);await assert.rejects(f.p.concurrent(f.request(),()=>{throw Error('provider uncertain')},f.context));assert.equal(f.state().releases,0);
 const blocked=await f.p.concurrent(f.request(),()=>{throw Error('never')},f.context);assert.equal(blocked.status,429);
 await assert.rejects(f.p(f.request(),()=>new Response('unsafe'),f.context),/protect.concurrent/);
 const g=await fixture(t,'outage');const res=await g.p.concurrent(g.request(),()=>{throw Error('never')},g.context);assert.equal(res.status,503);
});
test('unsettled completion cannot keep SDK lifecycle alive after caller cancellation',async t=>{
 const f=await fixture(t);const ctl=new AbortController();
 await f.p.concurrent(new Request('https://owned.test/chat',{signal:ctl.signal}),()=>({response:new Response('stream'),finished:new Promise(()=>{})}),f.context);
 ctl.abort();await Promise.race([Promise.all(f.tasks),pause(1000).then(()=>{throw Error('SDK lifecycle hung')})]);assert.equal(f.state().releases,0);
});
