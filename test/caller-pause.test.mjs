import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createActionProtection,ActionDenied} from '../actions.mjs';
import {actionCallerEvidence} from '../action-runtime.mjs';
const property='11111111-1111-4111-8111-111111111111';
const identity=subject=>({schema:1,subject,tenant:'tenant-a',issuer:'fixture',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]});
async function fixture(t){
 const reports=[],checks=[];let paused=true,broken=false,slow=false;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 if(req.url.endsWith('/reports')){reports.push(body);res.writeHead(202);res.end();return;}
 checks.push(body);if(slow){return;}if(broken){res.writeHead(503);res.end();return;}
 const allowed=!paused||body.caller!==actionCallerEvidence(config,identity('blocked')).id;
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schema:1,property_id:property,caller:body.caller,allowed,reason:allowed?'caller_allowed':'caller_paused'}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const config={webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:property,subjectSecret:'s'.repeat(32),reportCaller:true,callerPause:true,callerPauseTimeoutMs:250};
 let executed=0;const guard=createActionProtection({policyVersion:'v1',sharedRuntime:config,authenticate:subject=>identity(subject),actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>++executed}}});
 return {guard,config,reports,checks,calls:()=>executed,resume:()=>paused=false,pause:()=>paused=true,break:()=>broken=true,slow:()=>slow=true};
}
test('paused caller never executes; other callers and resume work without stale caches',async t=>{
 const f=await fixture(t);await assert.rejects(f.guard.run('read',{},'blocked'),e=>e instanceof ActionDenied&&e.reason==='caller_paused');
 assert.equal(f.calls(),0);await f.guard.run('read',{},'other');assert.equal(f.calls(),1);f.resume();await f.guard.run('read',{},'blocked');assert.equal(f.calls(),2);await f.guard.flush();
 assert.equal(f.checks.length,3);assert.equal(f.reports[0].handler_attempted,false);assert.equal(f.reports[0].checks.find(c=>c.id==='caller_pause').decision,'deny');
 assert.ok(!JSON.stringify(f.checks).includes('blocked'));
});
test('caller-control outage and timeout fail open with visible unavailable evidence',async t=>{
 const f=await fixture(t);f.break();await f.guard.run('read',{},'blocked');await f.guard.flush();assert.equal(f.calls(),1);assert.ok(f.reports.some(r=>r.degraded&&r.checks.some(c=>c.id==='caller_pause'&&c.decision==='unavailable')));
 f.slow();const start=performance.now();await f.guard.run('read',{},'blocked');assert.ok(performance.now()-start<1500);assert.equal(f.calls(),2);await f.guard.flush();
});
test('caller control requires explicit attribution opt-in',async t=>{
 const f=await fixture(t);assert.throws(()=>createActionProtection({policyVersion:'v1',authenticate:()=>identity('x'),sharedRuntime:{...f.config,reportCaller:false},actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>1}}}),/requires caller reporting/);
});

test('saving a pause does not cancel already running work',async t=>{
 const f=await fixture(t);f.resume();let finish,started;const began=new Promise(r=>started=r);
 const guard=createActionProtection({policyVersion:'v1',sharedRuntime:f.config,authenticate:()=>identity('blocked'),actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{started();return new Promise(r=>finish=r);}}}});
 const running=guard.run('read',{},null);await began;f.pause();
 await assert.rejects(guard.run('read',{},null),e=>e.reason==='caller_paused');finish('completed');assert.equal(await running,'completed');await guard.flush();
});

test('caller-pause timeout rejects invalid configuration',async t=>{
 const f=await fixture(t);
 for(const timeout of [0,-1,10001,NaN,'1000'])assert.throws(()=>createActionProtection({policyVersion:'v1',authenticate:()=>identity('x'),sharedRuntime:{...f.config,callerPauseTimeoutMs:timeout},actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>1}}}),/Invalid caller pause timeout/);
});
