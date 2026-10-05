import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createActionProtection} from '../actions.mjs';
import {collectMCPDiagnostics} from '../scripts/inspect-mcp-controls.mjs';
async function fixture(t,{status=202,observer,stall=false}={}){
 const reports=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;reports.push(JSON.parse(raw));if(stall)return;res.writeHead(status);res.end('private-response');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const diagnostics=collectMCPDiagnostics();let calls=0;
 const guard=createActionProtection({policyVersion:'v1',onEvent:diagnostics.onEvent,sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${server.address().port}`,propertyId:'11111111-1111-4111-8111-111111111111',webdecoyKey:'private-key',subjectSecret:'x'.repeat(32),reportingTimeoutMs:stall?50:1000,onReport:observer??diagnostics.onReport},authenticate:()=>({schema:1,subject:'private-subject',tenant:'private-tenant',issuer:'fixture',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]}),actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return 'private-result';}}}});
 return {guard,diagnostics,reports,calls:()=>calls};
}
test('HTTP receipts correlate attempts/completion without claiming retained evidence',async t=>{
 const f=await fixture(t);assert.equal(await f.guard.run('read',{},null),'private-result');await f.guard.flush();await new Promise(r=>setImmediate(r));const r=f.diagnostics.snapshot();assert.equal(r.reporting.accepted,2);assert.equal(r.reporting.missingOrPending,0);assert.equal(r.phases.completed,1);assert.equal(r.reporting.retainedEvidence,'not_verified');assert.equal(f.calls(),1);for(const secret of ['private-subject','private-tenant','private-key','private-result','private-response'])assert.ok(!JSON.stringify(r).includes(secret));
});
for(const config of [{status:503},{stall:true}])test('report failure remains explicit without retrying the action',async t=>{
 const f=await fixture(t,config);assert.equal(await f.guard.run('read',{},null),'private-result');await f.guard.flush();await new Promise(r=>setTimeout(r,10));const r=f.diagnostics.snapshot();assert.equal(r.reporting.accepted,0);assert.ok(r.reporting.unavailable+r.reporting.missingOrPending===2);assert.equal(f.calls(),1);
});
test('throwing and hung reporting observers preserve results and shutdown',async t=>{
 for(const observer of [()=>{throw Error('observer');},()=>new Promise(()=>{})]){const f=await fixture(t,{observer});assert.equal(await f.guard.run('read',{},null),'private-result');await f.guard.flush();assert.equal(f.calls(),1);}
});
test('missing/mismatched receipts and bounded collection remain unknown',()=>{
 const d=collectMCPDiagnostics(),actionId='11111111-1111-4111-8111-111111111111';
 const eventId='22222222-2222-4222-8222-222222222222';d.onEvent({eventId,actionId,outcome:'completed',checks:[]});d.onReport({eventId,actionId:'33333333-3333-4333-8333-333333333333',status:'accepted'});assert.equal(d.snapshot().reporting.missingOrPending,1);
 for(let i=0;i<1100;i++)d.onEvent({eventId:`${i.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,actionId,outcome:'attempted',checks:[]});assert.ok(d.snapshot().dropped>0);assert.equal(d.snapshot().phases.completed+d.snapshot().phases.attempted,1000);
});
