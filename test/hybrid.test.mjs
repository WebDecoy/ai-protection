import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {createAIProtection} from '../fetch.mjs';
const req = () => new Request('https://example.test/api/chat', {method:'POST',body:JSON.stringify({plan:'paid'})});
const rule = (evaluate, extra={}) => ({id:'plan_policy',mode:'enforce',evaluate,...extra});

test('local plan denial uses server context, makes no network call and cannot be bypassed by body claims',async t=>{
  const {state,options}=await fixture(t);let called=false;
  const protect=createAIProtection({...options,protectionMode:'observe',
    resolveClientIP:()=>{throw new Error('should not resolve');},
    rules:[rule(c=>({allowed:c.plan==='paid',reason:'paid_required'}))]});
  const response=await protect(req(),()=>{called=true;return new Response();},{plan:'free',userId:'private-user'});
  await protect.flush();
  assert.equal(response.status,403);assert.equal(called,false);assert.equal(state.calls+state.configCalls,0);
  assert.equal(state.events[0].checks[1].decision,'skipped');
  assert.equal(JSON.stringify(state.events).includes('private-user'),false);
});

test('direct decision API separates reporting, retains immutable per-rule evidence, never serializes context',async t=>{
  const {state,options}=await fixture(t);state.decision='block';
  const protect=createAIProtection({...options,rules:[rule(()=>({allowed:false,reason:'paid_required'}),{mode:'observe'})]});
  const decision=await protect.check(req(),{userId:'secret-user',prompt:'secret-prompt'});
  assert.equal(state.events.length,0);assert.equal(decision.conclusion,'deny');assert.equal(decision.reason,'request_denied');
  assert.equal(decision.checks[0].decision,'deny');assert.equal(decision.checks[0].mode,'observe');assert.equal(decision.degraded,false);
  assert.throws(()=>{decision.conclusion='allow';},TypeError);assert.ok(Object.isFrozen(decision.checks[0]));
  await protect.report(decision,{handlerAttempted:false,unexpected:'secret-value'});
  await protect.report(decision);await protect.report({...decision});assert.equal(state.events.length,1);
  const serialized=JSON.stringify({payload:state.payload,events:state.events});
  for(const secret of ['secret-user','secret-prompt','secret-value'])assert.equal(serialized.includes(secret),false);
});

test('local allows never bypass remote denial; cloud and account outages are visible and fail open',async t=>{
  const {state,options}=await fixture(t);
  const protect=createAIProtection({...options,rules:[rule(()=>({allowed:true}))]});
  state.decision='challenge';assert.equal((await protect.check(req())).conclusion,'deny');
  state.status=503;let decision=await protect.check(req());
  assert.equal(decision.conclusion,'allow');assert.equal(decision.degraded,true);assert.equal(decision.checks[1].reason,'detector_unavailable');
  state.configStatus=503;const fresh=createAIProtection({...options,rules:[rule(()=>({allowed:true}))]});
  const calls=state.calls;decision=await fresh.check(req());
  assert.equal(decision.conclusion,'allow');assert.equal(decision.degraded,true);assert.equal(state.calls,calls);
});

test('local rule errors have independent failure policy; raw exceptions never appear in decisions',async t=>{
  const {state,options}=await fixture(t);const broken=()=>{throw new Error('private database error');};
  for(const [extra,conclusion] of [[{},'deny'],[{failureMode:'open'},'allow'],[{mode:'observe'},'allow']]){
    const protect=createAIProtection({...options,rules:[rule(broken,extra)]});
    const decision=await protect.check(req());
    assert.equal(decision.conclusion,conclusion);assert.equal(decision.degraded,true);
    if(conclusion==='deny')assert.equal(decision.status,503);
    await protect.report(decision);
  }
  assert.equal(JSON.stringify(state.events).includes('private database error'),false);
});

test('async/malformed local rules cannot silently grant access and invalid rule configurations fail startup',async t=>{
  const {options}=await fixture(t);
  for(const evaluate of [async()=>{throw new Error('secret');},()=>({allowed:'yes'}),()=>({allowed:false,reason:'sensitive text'})]){
    const decision=await createAIProtection({...options,rules:[rule(evaluate)]}).check(req());
    assert.equal(decision.status,503);assert.equal(decision.reason,'local_rule_error');
  }
  for(const rules of [[rule(()=>({allowed:true}),{id:undefined})],[rule(()=>({allowed:true})),rule(()=>({allowed:true}))],[rule(()=>({allowed:true}),{id:'webdecoy'})]])
    assert.throws(()=>createAIProtection({...options,rules}));
});

test('reporting rejection and lifecycle-hook failure do not reject or change the response',async t=>{
  const {options}=await fixture(t);const tasks=[];
  const protect=createAIProtection({...options,onObservation:async()=>{throw new Error('sensitive sink failure');},
    waitUntil:task=>{tasks.push(task);throw new Error('host failure');}});
  const response=new Response('hello');assert.equal(await protect(req(),()=>response),response);
  await Promise.all(tasks);await protect.flush();assert.equal(tasks.length,1);
});

test('slow reporting does not gate inference; queue is bounded, timeout aborts sink and flush completes',async t=>{
  const {options}=await fixture(t);let signal,calls=0;const tasks=[];
  const protect=createAIProtection({...options,resolveClientIP:()=>null,reportingTimeoutMs:30,maxPendingReports:1,
    onObservation:(_event,o)=>{calls++;signal=o.signal;return new Promise(()=>{});},waitUntil:p=>tasks.push(p)});
  assert.equal((await protect(req(),()=>new Response('ok'))).status,200);
  assert.equal(signal.aborted,false);
  await protect(req(),()=>new Response('also ok'));
  assert.equal(calls,1);assert.equal(tasks.length,1);
  await protect.flush();assert.equal(signal.aborted,true);
});
