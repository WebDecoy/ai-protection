import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionProtection, ActionDenied} from '../actions.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const caller = () => ({schema:1,subject:'user',tenant:'tenant',issuer:'fixture',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:['read']});
function guard(version, execute, events, policy = () => true) {
  return createActionProtection({policyVersion:version,authenticate:caller,onEvent:e=>events.push(e),actions:{read:{requiredScopes:['read'],validate:()=>true,authorize:()=>true,policy,execute}}});
}

test('replacing a registry applies the new policy to new requests and preserves in-flight evidence', async () => {
  const started=deferred(), finish=deferred(), events=[];
  let calls=0;
  let active=guard('v1',async()=>{calls++;started.resolve();await finish.promise;return 'original';},events);
  const pending=active.run('read',{},{});
  await started.promise;
  active=guard('v2',()=>{calls++;},events,()=>false);
  await assert.rejects(active.run('read',{},{}),e=>e instanceof ActionDenied&&e.reason==='policy_denied');
  finish.resolve();
  assert.equal(await pending,'original');
  assert.equal(calls,1);
  assert.deepEqual(events.map(e=>[e.policyVersion,e.outcome]),[['v1','attempted'],['v2','not_attempted'],['v1','completed']]);
  assert.equal(events[0].actionId,events[2].actionId);
});

for(const failure of [false,true])test(`callback-owned streaming ${failure?'failure remains unknown':'finishes before completion'}`,async()=>{
  const started=deferred(), next=deferred(), events=[], chunks=[];
  const error=new Error('provider disconnected');
  let calls=0;
  async function* provider(){yield 'first';started.resolve();await next.promise;if(failure)throw error;yield 'second';}
  const protection=guard('stream_v1',async()=>{calls++;for await(const chunk of provider())chunks.push(chunk);return chunks.join('');},events);
  const pending=protection.run('read',{},{});
  await started.promise;
  assert.deepEqual(events.map(e=>e.outcome),['attempted']);
  next.resolve();
  if(failure)await assert.rejects(pending,e=>e===error);
  else assert.equal(await pending,'firstsecond');
  assert.equal(calls,1);
  assert.deepEqual(chunks,failure?['first']:['first','second']);
  assert.deepEqual(events.map(e=>e.outcome),['attempted',failure?'unknown':'completed']);
});

test('cancellation during callback-owned streaming runs cleanup and never retries',async()=>{
  const started=deferred(), events=[], controller=new AbortController();
  let calls=0, cleaned=0;
  const protection=guard('stream_v1',async({signal})=>{
    calls++;
    try {
      started.resolve();
      await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    } finally { cleaned++; }
  },events);
  const pending=protection.run('read',{},{},{signal:controller.signal});
  await started.promise;
  controller.abort();
  await assert.rejects(pending,e=>e===controller.signal.reason);
  assert.equal(calls,1);assert.equal(cleaned,1);
  assert.deepEqual(events.map(e=>e.outcome),['attempted','unknown']);
  assert.equal(events.at(-1).reason,'execution_cancelled');
});
