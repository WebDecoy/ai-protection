import test from 'node:test';
import assert from 'node:assert/strict';
import {checkModelProtection} from '../scripts/doctor-model.mjs';

const propertyId='7c9e6679-7425-40de-944b-e07fc1f90ae7';
const protection=(extra={})=>({webdecoyUrl:'https://ai-protection.example',webdecoyKey:'real-key-not-used',propertyId,scopeId:'chat',subjectSecret:'s'.repeat(32),
 resolveClientIP:()=>{throw Error('the doctor must not call the real resolver');},
 rules:[{id:'plan_limit',mode:'enforce',evaluate:context=>({allowed:context.plan!=='blocked',reason:'plan_limit',status:403})}],...extra});
const budget=(extra={})=>({webdecoyUrl:'https://ai-protection.example',webdecoyKey:'real-key-not-used',propertyId,ruleId:'chat_budget',subjectSecret:'b'.repeat(32),windowSeconds:3600,
 limits:{account_tokens:10000},mode:'enforce',failureMode:'closed',prices:{small:{provider:'ollama',model:'tiny',inputMicrosPerMillion:0,outputMicrosPerMillion:0}},
 subject:context=>({accountId:context.account,organizationId:'org'}),...extra});
const statuses=r=>Object.fromEntries(r.checks.map(c=>[c.name,c.status]));
const quiet=async fn=>{const warn=console.warn;console.warn=()=>{};try{return await fn();}finally{console.warn=warn;}};

test('documented admission, streaming, cancellation, outage and budget behavior with a stub provider',async()=>{
 const r=await quiet(()=>checkModelProtection({protection:protection(),budget:budget(),allowedContext:{plan:'free',account:'a1'},deniedContext:{plan:'blocked',account:'a1'}}));
 assert.equal(r.passed,true,JSON.stringify(r.checks));
 assert.deepEqual(statuses(r),{allowed:'verified',local_denial:'verified',detector_block:'verified',streaming:'verified',cancellation:'verified',outage:'verified',budget_settlement:'verified',budget_denied:'verified'});
 assert.equal(r.checks.find(c=>c.name==='outage').expected,'allow_degraded');
 assert.deepEqual(r.checks.find(c=>c.name==='budget_settlement').observed.usagePhases.sort(),['finish','start']);
 assert.equal(r.diagnostics.requestCorrelation.status,'verified_for_documented_pattern');
 assert.equal(r.diagnostics.browserReceipts.status,'unconfigured');
 assert.equal(r.diagnostics.reporting.status,'delivered_to_stand_in');
 assert.equal(r.diagnostics.reporting.hostLifecycle,'unconfigured');
 // Independent count: allowed, block(0), streaming, cancellation, outage, budget settlement = 5 calls; denials never reached it.
 assert.equal(r.stubProvider.calls,5);assert.equal(r.stubProvider.paidCalls,0);
 assert.ok(!JSON.stringify(r).includes('real-key-not-used'));
});

test('closed detector failure mode denies during an outage; observe mode records but does not block',async()=>{
 const closed=await quiet(()=>checkModelProtection({protection:protection({detectorFailureMode:'closed'}),allowedContext:{plan:'free'}}));
 assert.equal(closed.passed,true,JSON.stringify(closed.checks));
 assert.deepEqual(closed.checks.find(c=>c.name==='outage').observed,{status:503,providerCalls:0});
 const observe=await quiet(()=>checkModelProtection({protection:protection({protectionMode:'observe'}),allowedContext:{plan:'free'}}));
 assert.equal(observe.passed,true);
 const block=observe.checks.find(c=>c.name==='detector_block');assert.equal(block.observed.providerCalls,1);assert.match(block.note,/not enforced/);
 assert.equal(observe.diagnostics.budget.status,'unconfigured');assert.equal(observe.diagnostics.requestCorrelation.status,'unconfigured');
});

test('a local rule left in observe mode fails the denial check with a remedy',async()=>{
 const p=protection({rules:[{id:'plan_limit',mode:'observe',evaluate:context=>({allowed:context.plan!=='blocked',reason:'plan_limit',status:403})}]});
 const r=await quiet(()=>checkModelProtection({protection:p,allowedContext:{plan:'free'},deniedContext:{plan:'blocked'}}));
 assert.equal(r.passed,false);
 const denial=r.checks.find(c=>c.name==='local_denial');assert.equal(denial.status,'failed');assert.equal(denial.observed.providerCalls,1);assert.match(denial.remediation,/mode: enforce/);
});

test('browser receipts: forwarded alone, missing ones fail open, validity never claimed',async()=>{
 const r=await quiet(()=>checkModelProtection({protection:protection({browserEvidenceOrigin:'https://chat.example'}),allowedContext:{plan:'free'}}));
 assert.equal(r.passed,true,JSON.stringify(r.checks));
 assert.deepEqual({status:r.diagnostics.browserReceipts.status,missing:r.diagnostics.browserReceipts.missingReceipt,validity:r.diagnostics.browserReceipts.validity},{status:'forwarded',missing:'fails_open',validity:'not_verified_locally'});
});

test('disabled reporting is reported, and correlation is not claimed without admission reports',async()=>{
 const r=await quiet(()=>checkModelProtection({protection:protection({reportToWebDecoy:false}),budget:budget(),allowedContext:{plan:'free',account:'a1'}}));
 assert.equal(r.diagnostics.reporting.status,'disabled');
 const settle=r.checks.find(c=>c.name==='budget_settlement');assert.equal(settle.status,'failed');assert.equal(settle.observed.admissionReport,false);
 assert.equal(r.diagnostics.requestCorrelation.status,'failed');assert.equal(r.passed,false);
});

test('concurrency-configured protection is exercised through the concurrent path',async()=>{
 const r=await quiet(()=>checkModelProtection({protection:protection({concurrency:{ruleId:'chat_parallel',accountLimit:2,featureLimit:10,mode:'enforce',failureMode:'closed',subject:c=>({accountId:c.account})}}),allowedContext:{plan:'free',account:'a1'}}));
 assert.equal(r.passed,true,JSON.stringify(r.checks));
 assert.equal(r.checks.find(c=>c.name==='outage').expected,'deny_503');
 assert.ok(r.standIn.concurrency>0);
});

test('invalid options stop before any request',async()=>{
 for(const bad of [undefined,{},protection({subjectSecret:'short'})]){
  const r=await checkModelProtection({protection:bad});assert.equal(r.passed,false);assert.ok(['unconfigured','invalid'].includes(r.checks[0].status));
 }
});

// Broken integrations the doctor must catch. Each wraps the real SDK and breaks one guarantee.
import {createAIProtection,createAIBudget} from '../fetch.mjs';
const wrap=(guard,overrides)=>Object.assign(overrides.protect??guard,{check:guard.check,report:guard.report,flush:guard.flush,concurrent:overrides.concurrent??guard.concurrent});
const brokenFactories={
 ignoresDenial:o=>{const g=createAIProtection(o);return wrap(g,{protect:async(req,handler,ctx)=>{await g.check(req,ctx);return handler();}});},
 // Worst case: the provider runs, then the caller still sees the real denial status.
 callsThenDenies:o=>{const g=createAIProtection(o);return wrap(g,{protect:async(req,handler,ctx)=>{await handler();return g(req,handler,ctx);}});},
 rewritesStream:o=>{const g=createAIProtection(o);return wrap(g,{protect:async(req,handler,ctx)=>{const r=await g(req,handler,ctx);const text=await r.text();return new Response(text.split('\n\n').reverse().join('\n\n'),{status:r.status,headers:r.headers});}});},
 dropsReceipts:o=>{const {browserEvidenceOrigin,...rest}=o;return createAIProtection(rest);},
 dropsCancellation:o=>{const g=createAIProtection(o),original=g.concurrent;return wrap(g,{concurrent:(req,handler,ctx)=>original(req,()=>handler({signal:new AbortController().signal}),ctx)});},
};
const concurrency={ruleId:'chat_parallel',accountLimit:2,featureLimit:10,subject:c=>({accountId:c.account})};
test('the doctor catches integrations that break each guarantee',async()=>{
 const run=(createProtection,extra={},more={})=>quiet(()=>checkModelProtection({protection:protection(extra),allowedContext:{plan:'free',account:'a1'},deniedContext:{plan:'blocked',account:'a1'},createProtection,...more}));
 const leaky=await run(brokenFactories.ignoresDenial);
 assert.equal(leaky.passed,false);assert.equal(statuses(leaky).local_denial,'failed');assert.equal(statuses(leaky).detector_block,'failed');
 const hidden=await run(brokenFactories.callsThenDenies);
 for(const name of ['local_denial','detector_block']){const c=hidden.checks.find(x=>x.name===name);assert.equal(c.status,'failed',name);assert.ok(c.observed.status>=400&&c.observed.providerCalls>0,name);}
 assert.equal(statuses(await run(brokenFactories.rewritesStream)).streaming,'failed');
 const receipts=await run(brokenFactories.dropsReceipts,{browserEvidenceOrigin:'https://chat.example'});
 assert.equal(receipts.diagnostics.browserReceipts.status,'not_forwarded');
 const cancel=await run(brokenFactories.dropsCancellation,{concurrency});
 const c=cancel.checks.find(x=>x.name==='cancellation');assert.equal(c.status,'failed');assert.equal(c.observed.providerSawAbort,false);
 // A budget that starts the provider call even when the reservation is refused.
 const runsAnyway=o=>{const b=createAIBudget(o);return {flush:b.flush,run:(ctx,call,work,signal)=>b.run(ctx,call,work,signal).catch(async e=>{await work({signal:new AbortController().signal});throw e;})};};
 const overspend=await run(createAIProtection,{},{budget:budget(),createBudget:runsAnyway});
 assert.equal(statuses(overspend).budget_denied,'failed');
});
