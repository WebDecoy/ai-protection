import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIProtection} from '../fetch.mjs';
import {createAccountBinding} from '../account.mjs';
import {fixture} from './fixture.mjs';
import {abortable} from '../transport.mjs';

const request=signal=>new Request('https://owned.test/users/private-user/chat?secret=query',{signal,headers:{'x-forwarded-for':'203.0.113.99'}});
test('trusted resolver timeout is bounded/degraded; explicit route hides path identifiers',async t=>{
 const {options,state}=await fixture(t);let cancelled=false;
 const p=createAIProtection({...options,clientIPTimeoutMs:30,resolveClientIP:(_r,{signal})=>{signal.addEventListener('abort',()=>cancelled=true);return new Promise(()=>{});}});
 const before=performance.now();const original=new Response('ok');assert.equal(await p(request(),()=>original),original);
 const elapsed=performance.now()-before;assert.ok(elapsed>=20&&elapsed<500,`${elapsed}ms`);assert.equal(cancelled,true);assert.equal(state.calls,0);
 await p.flush();assert.equal(state.events[0].reason,'client_ip_unavailable');
 const q=createAIProtection({...options,route:'/users/{id}/chat'});await q(request(),()=>new Response());await q.flush();
 const wire=JSON.stringify(state.payload);assert.equal(state.payload.request_metadata.path,'/users/{id}/chat');assert.equal(state.payload.request_metadata.ip,'192.0.2.1');assert.ok(!wire.includes('private-user')&&!wire.includes('secret=query')&&!wire.includes('203.0.113.99'));
});
test('caller cancellation stops waiting on a hung resolver before any model work',async t=>{
 const {options}=await fixture(t);const abort=new AbortController();let calls=0;
 const p=createAIProtection({...options,resolveClientIP:()=>new Promise(()=>{})});const result=p(request(abort.signal),()=>{calls++;return new Response()});
 setTimeout(()=>abort.abort(),10);await assert.rejects(result,{name:'AbortError'});assert.equal(calls,0);
});
test('shared config waiters respect independent cancellation',async t=>{
 let requests=0;const server=http.createServer((_req,res)=>{requests++;setTimeout(()=>res.end(JSON.stringify({schema:1,mode:'enforce',property_id:'11111111-1111-4111-8111-111111111111',organization_id:'22222222-2222-4222-8222-222222222222',observe:true,enforce:true})),150)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
 const binding=createAccountBinding({webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:'11111111-1111-4111-8111-111111111111',detectorTimeoutMs:1000});
 const first=binding(new AbortController().signal);const abort=new AbortController();const second=binding(abort.signal);abort.abort();
 await assert.rejects(second,{name:'AbortError'});assert.equal((await first).status,'verified');assert.equal(requests,1);
});
test('oversized/malformed/stalled control responses fail open and redirects never follow credentials',async t=>{
 let mode='oversized',part='config',destinationCalls=0;
 const dest=http.createServer((_r,res)=>{destinationCalls++;res.end('{}')});await new Promise(r=>dest.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>dest.close(r)));
 const valid={schema:1,mode:'enforce',property_id:'11111111-1111-4111-8111-111111111111',organization_id:'22222222-2222-4222-8222-222222222222',observe:true,enforce:true};
 const server=http.createServer((req,res)=>{
  if(req.url.endsWith('/'+part)){
   if(mode==='redirect'){res.writeHead(302,{location:`http://127.0.0.1:${dest.address().port}/leak`});res.end();return}
   if(mode==='stall'){res.writeHead(200);res.write('{');return}
   res.end(mode==='oversized'?' '.repeat(65537)+'{}':'{bad');return;
  }
  res.end(JSON.stringify(req.url.endsWith('/config')?valid:{decision_mode:'unified_v1',decision:'allow'}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
 for(part of ['config','detect'])for(mode of ['oversized','malformed','stall','redirect']){
  const p=createAIProtection({webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture-secret',propertyId:valid.property_id,scopeId:'test',subjectSecret:'x'.repeat(32),resolveClientIP:()=> '192.0.2.1',detectorTimeoutMs:35,reportToWebDecoy:false,onObservation:()=>{}});
  const before=performance.now();const d=await p.check(request());assert.equal(d.conclusion,'allow');assert.equal(d.degraded,true);assert.ok(performance.now()-before<700);
 }
 assert.equal(destinationCalls,0);
});

test('already-cancelled waits consume rejected work without an unhandled rejection',async()=>{
 const c=new AbortController();c.abort();
 await assert.rejects(abortable(Promise.reject(Error('private resolver error')),c.signal),{name:'AbortError'});
 await new Promise(r=>setImmediate(r));
});
