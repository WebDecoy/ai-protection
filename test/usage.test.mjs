import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIBudget} from '../fetch.mjs';

test('usage telemetry correlates multiple attempts, keeps content private, and tolerates reporting outage',async t=>{
 const events=[];let reserves=0,settles=0,starts=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const p=JSON.parse(raw);
  if(req.url.endsWith('/usage')){
   assert.ok(!raw.includes('private-account'));assert.ok(!raw.includes('private-prompt'));assert.ok(!raw.includes('secret-model'));
   events.push(p);res.writeHead(503);res.end();return;
  }
  if(p.operation==='reserve')reserves++;else settles++;
  res.end(JSON.stringify({schema:1,allowed:true,granted:p.operation==='reserve',reason:p.operation==='reserve'?'budget_allowed':'budget_settled',reservation_id:'22222222-2222-4222-8222-222222222222',retry_after_seconds:0,overrun:false}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const b=createAIBudget({webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:'11111111-1111-4111-8111-111111111111',ruleId:'chat',subjectSecret:'x'.repeat(32),windowSeconds:60,limits:{account_tokens:100},prices:{fixture:{provider:'ollama',model:'secret-model',inputMicrosPerMillion:1000000,outputMicrosPerMillion:2000000}},subject:()=>({accountId:'private-account',organizationId:'private-org'})});
 const call={requestId:'33333333-3333-4333-8333-333333333333',priceId:'fixture',maxInputTokens:10,maxOutputTokens:20};
 const ids=[];
 for(let i=0;i<2;i++){
  const r=await b.run({prompt:'private-prompt'},call,()=>{starts++;return {value:'original',finished:Promise.resolve({provider:'ollama',model:'secret-model',inputTokens:3,outputTokens:4})}});
  ids.push(r.callId);assert.equal(r.value,'original');assert.equal((await r.accounting).reason,'budget_settled');
 }
 await assert.rejects(b.run({},call,()=>{starts++;throw Error('private-prompt')}),/private-prompt/);
 await b.flush();assert.equal(starts,3);assert.equal(reserves,3);assert.equal(settles,2);
 assert.equal(new Set(ids).size,2);assert.equal(events.length,6);
 for(const id of ids){const pair=events.filter(e=>e.call_id===id);assert.equal(pair.length,2);assert.ok(pair.every(e=>e.request_id===call.requestId));const final=pair.find(e=>e.phase==='finish');assert.equal(final.cost_micros,11);assert.equal(final.input_tokens+final.output_tokens,7)}
 assert.equal(events.filter(e=>e.reason==='provider_error').length,1);
});
