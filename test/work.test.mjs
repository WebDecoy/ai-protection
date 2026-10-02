import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createActionProtection} from '../actions.mjs';import {createQuotaOperationId} from '../quota.mjs';
async function setup(t,{response='ok',failureMode='closed',mode='enforce',execute=()=>4,measure=x=>x}={}){
 const calls=[],events=[];let executions=0;
 const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);calls.push(body);
 if(req.url.endsWith('/reports')){res.writeHead(202);res.end();return;}
 if(response==='outage'||(response==='settle-outage'&&body.operation==='settle')){res.writeHead(503);res.end();return;}
 if(response==='conflict'){res.writeHead(409);res.end();return;}
 if(response==='lost'){res.destroy();return;}
 res.end(JSON.stringify({schema:1,allowed:response!=='exceeded',granted:body.operation==='reserve'&&response!=='replay'&&(response!=='exceeded'||body.mode==='observe'),replay:response==='replay',settled:body.operation==='settle',reason:body.operation==='settle'?'work_settled':response==='replay'?'work_replay':response==='exceeded'?'work_exceeded':'work_allowed',reserved_units:10,charged_units:body.units,remaining_units:20,retry_after_seconds:0}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const id=createQuotaOperationId();
 const guard=createActionProtection({authenticate:()=>({schema:1,subject:'private-user',tenant:'private-tenant',issuer:'private-issuer',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]}),policyVersion:'v1',onEvent:e=>events.push(e),sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:'11111111-1111-4111-8111-111111111111',subjectSecret:'x'.repeat(32)},actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,limits:{work:{ruleId:'read',maxUnits:10,windowSeconds:60,limits:{caller:30},failureMode,mode,measure,operationId:()=>id}},execute:ctx=>{executions++;return execute(ctx);}}}});
 return {guard,calls,events,executions:()=>executions};
}
test('reserves before callback and settles confirmed weighted work without sending arguments',async t=>{const f=await setup(t);assert.equal(await f.guard.run('read',{secret:'private-arguments'},null),4);await f.guard.flush();const work=f.calls.filter(x=>x.operation);assert.deepEqual(work.map(x=>[x.operation,x.units]),[['reserve',10],['settle',4]]);assert.equal(work[0].operation_id,work[1].operation_id);assert.ok(!JSON.stringify(f.calls).includes('private-'));assert.equal(f.events.at(-1).work.status,'settled');assert.equal(f.events.at(-1).work.charged_units,4);});
for(const response of ['replay','conflict','lost'])test(`${response} cannot cause a second execution`,async t=>{const f=await setup(t,{response});await assert.rejects(f.guard.run('read',{},null));await f.guard.flush();assert.equal(f.executions(),0);assert.equal(f.calls.filter(x=>x.operation==='reserve').length,1);});
for(const failureMode of ['open','closed'])test(`state unavailable has explicit ${failureMode} behavior`,async t=>{const f=await setup(t,{response:'outage',failureMode});if(failureMode==='open')assert.equal(await f.guard.run('read',{},null),4);else await assert.rejects(f.guard.run('read',{},null),e=>e.status===503);await f.guard.flush();assert.equal(f.executions(),failureMode==='open'?1:0);assert.equal(f.events.at(-1).work.status,'unavailable');});
test('failed settlement preserves the successful result and marks accounting unknown',async t=>{const f=await setup(t,{response:'settle-outage'});assert.equal(await f.guard.run('read',{},null),4);await f.guard.flush();assert.equal(f.events.at(-1).outcome,'completed');assert.equal(f.events.at(-1).work.status,'unknown');assert.equal(f.executions(),1);});
test('callback failure never settles or refunds unknown work',async t=>{const f=await setup(t,{execute:()=>{throw Error('unknown external operation');}});await assert.rejects(f.guard.run('read',{},null));await f.guard.flush();assert.equal(f.calls.filter(x=>x.operation==='settle').length,0);assert.equal(f.events.at(-1).work.status,'unknown');});
for(const measure of [()=>11,()=>NaN,()=>Promise.reject(Error('invalid async measure'))])test('invalid measurement retains maximum charge',async t=>{const f=await setup(t,{measure});assert.equal(await f.guard.run('read',{},null),4);await f.guard.flush();assert.equal(f.calls.filter(x=>x.operation==='settle').length,0);assert.equal(f.events.at(-1).work.charged_units,10);assert.equal(f.events.at(-1).work.status,'unknown');});
test('cancellation after execution begins retains unknown work and does not settle',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const f=await setup(t,{execute:({signal})=>new Promise((_,reject)=>{started();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const controller=new AbortController();const pending=f.guard.run('read',{},null,{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending);await f.guard.flush();
 assert.equal(f.calls.filter(x=>x.operation==='settle').length,0);assert.equal(f.events.at(-1).work.status,'unknown');assert.equal(f.executions(),1);
});

test('observation records an exceeded allowance without claiming a hard ceiling',async t=>{const f=await setup(t,{response:'exceeded',mode:'observe'});assert.equal(await f.guard.run('read',{},null),4);await f.guard.flush();const start=f.events.find(e=>e.outcome==='attempted');assert.equal(start.checks[0].mode,'observe');assert.equal(start.checks[0].decision,'deny');assert.equal(f.executions(),1);});
