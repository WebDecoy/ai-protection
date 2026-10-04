import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createActionProtection,ActionDenied} from '../actions.mjs';
const property='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222';
async function fixture(t,callerPause=false){
 const requests=[],reports=[];let paused=true,broken=false,slow=false,malformed=false,callerBlocked=false,calls=0;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 if(req.url.endsWith('/reports')){reports.push(body);res.writeHead(202);res.end();return;}
 requests.push(body);if(slow)return;if(broken){res.writeHead(503);res.end();return;}
 const deny=paused&&body.server_id==='records'&&body.tool==='write';
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schema:2,property_id:malformed?'wrong':property,server_id:body.server_id,tool:body.tool,caller:body.caller,
 caller_control:body.caller?{allowed:!callerBlocked,reason:callerBlocked?'caller_paused':'caller_allowed',control_revision:callerBlocked?revision:null}:null,
 tool_control:{allowed:!deny,reason:deny?'tool_paused':'tool_allowed',control_revision:revision}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const config={webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:property,subjectSecret:'a'.repeat(32),toolPause:true,callerPause,reportCaller:callerPause,callerPauseTimeoutMs:100};
 const make=(serverId='records')=>createActionProtection({policyVersion:'v1',sharedRuntime:config,authenticate:()=>({schema:1,subject:'caller',tenant:'tenant',issuer:'fixture',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]}),actions:Object.fromEntries(['read','write'].map(name=>[name,{toolSchema:{serverId,hash:'a'.repeat(64)},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>++calls}]))});
 return {config,make,requests,reports,blockCaller:()=>callerBlocked=true,calls:()=>calls,resume:()=>paused=false,break:()=>broken=true,slow:()=>slow=true,malformed:()=>malformed=true};
}
test('tool pause blocks only the named server/tool and records the revision without caller reporting',async t=>{
 const f=await fixture(t),guard=f.make();await assert.rejects(guard.run('write',{},null),e=>e instanceof ActionDenied&&e.reason==='tool_paused');assert.equal(f.calls(),0);
 await guard.run('read',{},null);const other=f.make('other');await other.run('write',{},null);f.resume();await guard.run('write',{},null);assert.equal(f.calls(),3);await guard.flush();await other.flush();
 assert.equal(f.requests[0].caller,'');assert.equal(f.reports[0].tool_action.caller,undefined);assert.equal(f.reports[0].checks.find(c=>c.id==='tool_pause').control_revision,revision);
});
test('tool and caller controls share one request and preserve both check results',async t=>{
 const f=await fixture(t,true),guard=f.make();await assert.rejects(guard.run('write',{},null),e=>e.reason==='tool_paused');await guard.flush();assert.equal(f.requests.length,1);assert.match(f.requests[0].caller,/^[a-f0-9]{64}$/);assert.deepEqual(f.reports[0].checks.slice(1).map(c=>c.id),['caller_pause','tool_pause']);
 f.blockCaller();await assert.rejects(guard.run('read',{},null),e=>e.reason==='caller_paused');assert.equal(f.calls(),0);
});
test('tool controls fail open on unavailable, timed-out and malformed responses',async t=>{
 const f=await fixture(t),guard=f.make();f.break();await guard.run('write',{},null);f.slow();await guard.run('write',{},null);await guard.flush();assert.equal(f.calls(),2);assert.ok(f.reports.every(r=>r.degraded));
 const g=await fixture(t),malformed=g.make();g.malformed();await malformed.run('write',{},null);await malformed.flush();assert.equal(g.calls(),1);assert.equal(g.reports[0].checks[1].decision,'unavailable');
});
test('tool controls require explicit integration metadata and a boolean opt-in',async t=>{
 const f=await fixture(t);const options={policyVersion:'v1',authenticate:()=>{},sharedRuntime:f.config,actions:{write:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>1}}};
 assert.throws(()=>createActionProtection(options),/requires toolSchema/);assert.throws(()=>createActionProtection({...options,sharedRuntime:{...f.config,toolPause:'true'}}),/Invalid tool pause/);
});
