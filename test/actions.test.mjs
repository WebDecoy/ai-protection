import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionProtection, ActionDenied} from '../actions.mjs';
const identity = overrides => ({schema:1,subject:'user-a',tenant:'tenant-a',issuer:'test-auth',authenticationMethod:'server-session',expiresAt:Date.now()+60000,scopes:['record:read'],...overrides});
function fixture(overrides={}) {
  let calls=0; const events=[];
  const definitions={read:{requiredScopes:['record:read'],validate:args => typeof args?.recordId==='string',
    authorize:({caller,args})=>caller.tenant===(args.recordId==='a'?'tenant-a':'tenant-b'),
    execute:({args})=>{calls++;return {id:args.recordId};},...overrides.action}};
  const guard=createActionProtection({policyVersion:'v1',authenticate:overrides.authenticate??(()=>identity()),
    actions:definitions,onEvent:event=>events.push(event),...overrides.options});
  return {guard,events,definitions,calls:()=>calls};
}
const denied = reason => e => e instanceof ActionDenied && e.reason===reason;
test('allowed result is preserved and correlated evidence contains no identity or arguments',async()=>{
 const f=fixture();assert.deepEqual(await f.guard.run('read',{recordId:'a'},{}),{id:'a'});
 assert.equal(f.calls(),1);assert.deepEqual(f.events.map(e=>e.outcome),['attempted','completed']);
 assert.equal(f.events[0].actionId,f.events[1].actionId);
 for(const secret of ['user-a','tenant-a','recordId','test-auth'])assert.ok(!JSON.stringify(f.events).includes(secret));
});
for(const [name,overrides,input,reason] of [
 ['cross-tenant',{}, {recordId:'b',tenant:'tenant-a'},'permission_denied'],
 ['missing scopes',{authenticate:()=>identity({scopes:[]})},{recordId:'a'},'missing_scope'],
 ['expired identity',{authenticate:()=>identity({expiresAt:1})},{recordId:'a'},'authentication_required'],
 ['forged body identity',{authenticate:()=>null},{recordId:'a',subject:'admin',scopes:['record:read']},'authentication_required'],
 ['validation',{action:{validate:()=>false}},{recordId:'a'},'invalid_arguments'],
 ['truthy permission',{action:{authorize:()=>({allowed:true})}},{recordId:'a'},'permission_denied'],
 ['authz error',{action:{authorize:()=>{throw Error('private DB error');}}},{recordId:'a'},'authorization_unavailable'],
 ['restrictive policy',{action:{policy:()=>false}},{recordId:'a'},'policy_denied'],
 ['policy outage',{action:{policy:()=>{throw Error('outage');}}},{recordId:'a'},'policy_unavailable'],
])test(name+' never executes',async()=>{const f=fixture(overrides);await assert.rejects(f.guard.run('read',input,{}),denied(reason));assert.equal(f.calls(),0);assert.equal(f.events[0].outcome,'not_attempted');});
test('unknown/hidden tools cannot execute and names do not leak',async()=>{const f=fixture();await assert.rejects(f.guard.run('secret-tool-payload',{},{}),denied('action_not_registered'));assert.equal(f.calls(),0);assert.equal(f.events[0].action,'unregistered');});
test('an extra allow cannot override an application denial',async()=>{let policy=0;const f=fixture({action:{authorize:()=>false,policy:()=>{policy++;return true;}}});await assert.rejects(f.guard.run('read',{recordId:'a'},{}),denied('permission_denied'));assert.equal(policy,0);assert.equal(f.calls(),0);});
test('input, identity and action definitions are snapshotted',async()=>{
 const caller=identity();let release;const pending=new Promise(r=>release=r);
 const f=fixture({authenticate:async()=>{await pending;return caller;},action:{authorize:async({caller,args})=>{assert.ok(Object.isFrozen(caller.scopes));assert.ok(Object.isFrozen(args));return caller.tenant==='tenant-a'&&args.recordId==='a';}}});
 const args={recordId:'a'};const result=f.guard.run('read',args,{});args.recordId='b';f.definitions.read.execute=()=>{throw Error('changed');};release();assert.deepEqual(await result,{id:'a'});
});
test('cancellation during authorization prevents dispatch',async()=>{const c=new AbortController();const f=fixture({action:{authorize:()=>{c.abort();return true;}}});await assert.rejects(f.guard.run('read',{recordId:'a'},{},{signal:c.signal}),{name:'AbortError'});assert.equal(f.calls(),0);});
test('authentication expiry during authorization prevents dispatch',async()=>{const f=fixture({authenticate:()=>identity({expiresAt:Date.now()+20}),action:{authorize:async()=>{await new Promise(r=>setTimeout(r,30));return true;}}});await assert.rejects(f.guard.run('read',{recordId:'a'},{}),denied('authentication_expired'));assert.equal(f.calls(),0);});
test('reporting errors do not rerun or replace action results',async()=>{const f=fixture({options:{onEvent:async()=>{throw Error('sink down');}}});assert.deepEqual(await f.guard.run('read',{recordId:'a'},{}),{id:'a'});assert.equal(f.calls(),1);});
test('execution errors preserve error and mark outcome unknown, never retry',async()=>{let calls=0;const error=Error('private result');const f=fixture({action:{execute:()=>{calls++;throw error;}}});await assert.rejects(f.guard.run('read',{recordId:'a'},{}),e=>e===error);assert.equal(calls,1);assert.equal(f.events.at(-1).outcome,'unknown');assert.ok(!JSON.stringify(f.events).includes('private result'));});
test('invalid/big/cyclic/accessor input never executes or invokes getters',async()=>{const f=fixture();const cyclic={};cyclic.self=cyclic;let reads=0;for(const args of [cyclic,{recordId:'x'.repeat(17000)},{get recordId(){reads++;return 'a';}},new Date(),{number:NaN}])await assert.rejects(f.guard.run('read',args,{}),denied('invalid_arguments'));assert.equal(reads,0);assert.equal(f.calls(),0);});
test('hung authentication times out without dispatch even after late resolution',async()=>{let release;const pending=new Promise(r=>release=r);const f=fixture({authenticate:()=>pending,options:{admissionTimeoutMs:10}});await assert.rejects(f.guard.run('read',{recordId:'a'},{}),denied('admission_timeout'));release(identity());await new Promise(r=>setImmediate(r));assert.equal(f.calls(),0);});
test('hung authorization responds to cancellation without later dispatch',async()=>{let release;const pending=new Promise(r=>release=r);const c=new AbortController();const f=fixture({action:{authorize:()=>pending}});const result=f.guard.run('read',{recordId:'a'},{},{signal:c.signal});await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(result,{name:'AbortError'});release(true);await new Promise(r=>setImmediate(r));assert.equal(f.calls(),0);});
test('admission timer does not cancel successfully admitted work',async()=>{const f=fixture({options:{admissionTimeoutMs:15},action:{execute:async({signal})=>{await new Promise(r=>setTimeout(r,25));assert.equal(signal.aborted,false);return 'done';}}});assert.equal(await f.guard.run('read',{recordId:'a'},{}),'done');});
test('sparse enormous arrays are rejected before serialization',async()=>{const f=fixture();await assert.rejects(f.guard.run('read',new Array(2**32-1),{}),denied('invalid_arguments'));assert.equal(f.calls(),0);});
test('cancelled execution preserves uncertainty without retry',async()=>{let calls=0;const c=new AbortController();const f=fixture({action:{execute:()=>{calls++;c.abort();return 'possibly completed';}}});await assert.rejects(f.guard.run('read',{recordId:'a'},{},{signal:c.signal}),{name:'AbortError'});assert.equal(calls,1);assert.equal(f.events.at(-1).outcome,'unknown');});
test('hung observer calls are bounded and never stop actions',async()=>{let observed=0;const f=fixture({options:{onEvent:()=>{observed++;return new Promise(()=>{});}}});for(let i=0;i<60;i++)await f.guard.run('read',{recordId:'a'},{});assert.equal(f.calls(),60);assert.equal(observed,100);});
