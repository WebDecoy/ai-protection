import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIBudget,budgetCost,ollamaBudgetUsage,BudgetDenied} from '../fetch.mjs';
const price={provider:'ollama',model:'fixture',inputMicrosPerMillion:1000000,outputMicrosPerMillion:2000000};
const call={priceId:'fixture',maxInputTokens:10,maxOutputTokens:20};
const usage={provider:'ollama',model:'fixture',inputTokens:3,outputTokens:4};
async function fixture(t,kind='ok',extra={}){
 const wire=[];let starts=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  assert.ok(!raw.includes('private-account'));assert.ok(!raw.includes('private-org'));assert.ok(!raw.includes('prompt text'));
  const p=JSON.parse(raw);wire.push(p);
  if(kind==='outage'||kind==='settle_outage'&&p.operation==='settle'){res.writeHead(503);res.end();return}
  const r={schema:1,allowed:true,granted:p.operation==='reserve',reason:p.operation==='reserve'?'budget_allowed':'budget_settled',reservation_id:'22222222-2222-4222-8222-222222222222',retry_after_seconds:0,overrun:false};
  if(kind==='deny'){r.allowed=false;r.granted=false;r.reason='budget_exceeded';r.retry_after_seconds=7}
  if(kind==='observe'){r.allowed=false;r.reason='budget_exceeded'}
  if(kind==='malformed'){delete r.allowed}
  res.end(JSON.stringify(r));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const options={webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture-key',propertyId:'11111111-1111-4111-8111-111111111111',ruleId:'chat',subjectSecret:'x'.repeat(32),windowSeconds:60,limits:{account_tokens:100,account_micros:100},prices:{fixture:price},subject:()=>({accountId:'private-account',organizationId:'private-org'}),mode:'enforce',failureMode:'closed',...extra};
 const b=createAIBudget(options);
 return {b,wire,options,work:()=>{starts++;return {value:new Response('stream'),finished:Promise.resolve(usage)}},starts:()=>starts};
}
test('budget reserves conservative price before original streaming response; final usage reconciles once',async t=>{
 const f=await fixture(t);let finish;const finished=new Promise(r=>finish=r);const response=new Response('stream');
 const r=await f.b.run({},call,runtime=>{assert.equal(runtime.model,'fixture');assert.equal(runtime.maxOutputTokens,20);assert.equal(f.wire[0].tokens,30);assert.equal(f.wire[0].micros,50);return {value:response,finished}});
 assert.equal(r.value,response);assert.equal(f.wire.length,1);finish(usage);
 assert.equal((await r.accounting).reason,'budget_settled');await r.accounting;
 assert.equal(f.wire.length,2);assert.equal(f.wire[1].tokens,7);assert.equal(f.wire[1].micros,11);
});
test('budget denies before provider starts and maps state availability independently',async t=>{
 const f=await fixture(t,'deny');await assert.rejects(f.b.run({},call,f.work),e=>e instanceof BudgetDenied&&e.status===429&&e.retryAfterSeconds===7);assert.equal(f.starts(),0);
 for(const kind of ['outage','malformed']){
 const closed=await fixture(t,kind);await assert.rejects(closed.b.run({},call,closed.work),e=>e.status===503);assert.equal(closed.starts(),0);
 const open=await fixture(t,kind,{failureMode:'open'});const r=await open.b.run({},call,open.work);assert.equal((await r.accounting).reason,'budget_unavailable');assert.equal(open.starts(),1);
 }
 const observed=await fixture(t,'observe',{mode:'observe'});const r=await observed.b.run({},call,()=>({value:1,finished:Promise.resolve(null)}));assert.equal((await r.accounting).wouldDeny,true);
});
test('missing usage, model mismatch, error and cancellation never refund an uncertain reservation',async t=>{
 for(const value of [null,{...usage,model:'changed'},{...usage,inputTokens:-1},{...usage,outputTokens:NaN}]){
 const f=await fixture(t);const r=await f.b.run({},call,()=>({value:1,finished:Promise.resolve(value)}));assert.equal((await r.accounting).reason,'budget_usage_unknown');assert.equal(f.wire.length,1);
 }
 const f=await fixture(t);await assert.rejects(f.b.run({},call,()=>{throw Error('provider failed')}));assert.equal(f.wire.length,1);
 const g=await fixture(t);const ctl=new AbortController();const r=await g.b.run({},call,()=>({value:1,finished:new Promise(()=>{})}),ctl.signal);ctl.abort();assert.equal((await r.accounting).reason,'budget_usage_unknown');assert.equal(g.wire.length,1);
 const h=await fixture(t);const before=new AbortController();before.abort();await assert.rejects(h.b.run({},call,h.work,before.signal));assert.equal(h.starts(),0);assert.equal(h.wire.length,0);
});
test('settlement outage and provider overrun cannot trigger provider retry',async t=>{
 const f=await fixture(t,'settle_outage');const r=await f.b.run({},call,f.work);assert.equal((await r.accounting).reason,'budget_settlement_unavailable');assert.equal(f.starts(),1);
 const g=await fixture(t);const r2=await g.b.run({},call,()=>({value:1,finished:Promise.resolve({...usage,outputTokens:21})}));assert.equal((await r2.accounting).overrun,true);assert.equal(g.wire[1].tokens,24);
});
test('explicit price and integer arithmetic; unknown prices never start even fail-open',async t=>{
 assert.equal(budgetCost({...price,inputMicrosPerMillion:1,outputMicrosPerMillion:1},1,1),1);
 assert.equal(budgetCost({...price,inputMicrosPerMillion:1000000000,outputMicrosPerMillion:1000000000},10000000,10000000),20000000000);
 assert.equal(ollamaBudgetUsage({done:true,model:'fixture'}),null);
 assert.deepEqual(ollamaBudgetUsage({done:true,model:'fixture',prompt_eval_count:0,eval_count:0}),{provider:'ollama',model:'fixture',inputTokens:0,outputTokens:0});
 const f=await fixture(t,'ok',{failureMode:'open'});await assert.rejects(f.b.run({},{...call,priceId:'unknown'},f.work));assert.equal(f.starts(),0);assert.equal(f.wire.length,0);
 // Configuration mutation cannot change the pinned price used for settlement.
 const original=price.inputMicrosPerMillion;price.inputMicrosPerMillion=999;const r=await f.b.run({},call,f.work);await r.accounting;price.inputMicrosPerMillion=original;assert.equal(f.wire[0].micros,50);
});
test('retry/fallback/tool loops require a fresh reservation for every provider attempt',async t=>{
 const f=await fixture(t);for(let i=0;i<3;i++){const r=await f.b.run({},call,f.work);await r.accounting}
 assert.equal(f.starts(),3);const reserves=f.wire.filter(p=>p.operation==='reserve');assert.equal(reserves.length,3);assert.equal(new Set(reserves.map(p=>p.nonce)).size,3);
});
test('cancellation before completion ownership consumes rejected usage without refund',async t=>{
 const f=await fixture(t);const ctl=new AbortController();
 const r=await f.b.run({},call,()=>{ctl.abort();return {value:new Response('partial'),finished:Promise.reject(Error('cancelled upstream'))}},ctl.signal);
 assert.equal((await r.accounting).reason,'budget_usage_unknown');assert.equal(f.wire.length,1);
});
