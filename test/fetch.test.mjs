import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {createAIProtection} from '../fetch.mjs';

const request=(signal)=>new Request('https://example.test/api/chat?secret=query',{
  method:'POST',body:'private prompt',signal,headers:{authorization:'secret-token',cookie:'private-cookie'}});

test('preserves request body and original streaming Response; sends no prompt or header secrets',async t=>{
  const {state,options}=await fixture(t); const req=request();
  let cancelled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));},cancel(){cancelled=true;}}),{headers:{'x-custom':'retained'}});
  assert.equal(await createAIProtection(options)(req,async()=>{assert.equal(await req.text(),'private prompt');return response;}),response);
  const reader=response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value),'first'); await reader.cancel(); assert.equal(cancelled,true);
  const payload=JSON.stringify(state.payload);
  for(const secret of ['private prompt','secret-token','private-cookie','secret=query']) assert.equal(payload.includes(secret),false);
  assert.equal(state.payload.request_metadata.path,'/api/chat');
  assert.equal(state.events[0].handler_attempted,true); assert.equal(state.events[0].upstream_attempted,false);
});
test('block and challenge never call handler; observation and outage do',async t=>{
  const {state,options}=await fixture(t);const protect=createAIProtection(options);let calls=0;
  const handler=()=>{calls++;return new Response('ok');};
  for(const decision of ['block','challenge']){state.decision=decision;assert.equal((await protect(request(),handler)).status,403);}
  assert.equal(calls,0);
  assert.equal((await createAIProtection({...options,protectionMode:'observe'})(request(),handler)).status,200);
  state.status=503;assert.equal((await protect(request(),handler)).status,200);assert.equal(calls,2);
});
test('missing trusted IP skips scoring and records degraded coverage',async t=>{
  const {state,options}=await fixture(t);
  const protect=createAIProtection({...options,resolveClientIP:()=>null});
  const response=await protect(request(),()=>new Response('ok'));
  await protect.flush();
  assert.equal(response.status,200);assert.equal(state.calls,0);assert.equal(state.events[0].reason,'client_ip_unavailable');
});
test('aborting during detection never calls handler despite fail-open',async t=>{
  const {state,options}=await fixture(t);const controller=new AbortController();let called=false;
  state.onDetect=()=>controller.abort();
  await assert.rejects(createAIProtection(options)(request(controller.signal),()=>{called=true;return new Response();}),{name:'AbortError'});
  assert.equal(called,false); assert.equal(state.events[0].action,'cancelled');
});
test('handler errors propagate and do not leak into observations',async t=>{
  const {state,options}=await fixture(t);const error=new Error('private prompt');
  await assert.rejects(createAIProtection(options)(request(),()=>{throw error;}),e=>e===error);
  assert.equal(state.events[0].action,'handler_error');assert.equal(JSON.stringify(state.events).includes('private prompt'),false);
});
