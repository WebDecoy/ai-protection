import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createActionProtection} from '../actions.mjs';
const property='11111111-1111-4111-8111-111111111111';
async function fixture(t,{limit=2,outage=false,failureMode='closed',authorize=true}={}){
 const buckets=new Map(),reports=[],subjects=[];let executions=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
 assert.equal(req.headers['x-webdecoy-property-id'],property);assert.ok(!raw.includes('private-'));
 if(req.url.endsWith('/reports')){reports.push(body);res.writeHead(202);res.end();return;}
 subjects.push(body.subject);if(outage){res.writeHead(503);res.end();return;}
 const key=body.rule_id+body.subject,n=buckets.get(key)??0,allowed=n<body.limit;if(allowed)buckets.set(key,n+1);
 res.end(JSON.stringify({schema:1,allowed,reason:allowed?'account_quota_allowed':'account_quota_exceeded',remaining:Math.max(0,body.limit-n-1),reset_at:2000000000,retry_after_seconds:allowed?0:60}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const sharedRuntime={webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',propertyId:property,subjectSecret:'x'.repeat(32)};
 const make=()=>createActionProtection({policyVersion:'v1',sharedRuntime,authenticate:tenant=>({schema:1,subject:'private-reader',tenant,issuer:'private-issuer',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:['read']}),actions:{read:{requiredScopes:['read'],validate:()=>true,authorize:()=>authorize,limits:{callerQuota:{ruleId:'read_v1',limit,windowSeconds:60,mode:'enforce',failureMode}},execute:()=>{executions++;return 'ok';}}}});
 return {make,reports,subjects,executions:()=>executions};
}
test('replicas share caller allowance, tenants remain isolated, and report phases correlate',async t=>{const f=await fixture(t),a=f.make(),b=f.make();await a.run('read',{},'private-a');await b.run('read',{},'private-a');await assert.rejects(a.run('read',{},'private-a'),e=>e.status===429&&e.retryAfterSeconds===60);await b.run('read',{},'private-b');await Promise.all([a.flush(),b.flush()]);assert.equal(f.executions(),3);assert.equal(f.subjects[0],f.subjects[1]);assert.notEqual(f.subjects[0],f.subjects[3]);assert.equal(f.reports.length,7);const start=f.reports.find(r=>r.tool_action.outcome==='attempted');assert.ok(f.reports.some(r=>r.tool_action.action_id===start.tool_action.action_id&&r.tool_action.outcome==='completed'));assert.ok(f.reports.every(r=>r.schema===2));});
test('permission denial consumes no quota',async t=>{const f=await fixture(t,{authorize:false}),p=f.make();await assert.rejects(p.run('read',{},'private-a'));await p.flush();assert.equal(f.subjects.length,0);assert.equal(f.executions(),0);});
for(const failureMode of ['open','closed'])test(`state outage ${failureMode} is explicit and independent`,async t=>{const f=await fixture(t,{outage:true,failureMode}),p=f.make();if(failureMode==='closed')await assert.rejects(p.run('read',{},'private-a'),e=>e.status===503);else assert.equal(await p.run('read',{},'private-a'),'ok');await p.flush();assert.equal(f.executions(),failureMode==='closed'?0:1);assert.ok(f.reports.every(r=>r.degraded));});
test('release failure preserves completed value and reports degraded capacity without retry',async t=>{
 let executions=0,releases=0;const reports=[];
 const s=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const p=JSON.parse(raw);
 if(req.url.endsWith('/reports')){reports.push(p);res.writeHead(202);res.end();return;}
 if(p.operation==='release'){releases++;res.writeHead(503);res.end();return;}
 res.end(JSON.stringify({schema:1,allowed:true,granted:true,reason:'concurrency_allowed',retry_after_seconds:0,lease_id:'11111111-1111-4111-8111-111111111111',valid_for_ms:6000}));
 });await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));
 const guard=createActionProtection({policyVersion:'v1',sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${s.address().port}`,webdecoyKey:'fixture',propertyId:property,subjectSecret:'x'.repeat(32)},authenticate:()=>({schema:1,subject:'u',tenant:'t',issuer:'issuer',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]}),actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>true,limits:{concurrency:{ruleId:'release',accountLimit:1,featureLimit:1,ttlSeconds:6,mode:'enforce',failureMode:'closed'}},execute:()=>{executions++;return 'done';}}}});
 assert.equal(await guard.run('read',{},null),'done');await guard.flush();assert.equal(executions,1);assert.equal(releases,1);
 const completed=reports.find(r=>r.tool_action.outcome==='completed');assert.equal(completed.degraded,true);assert.ok(completed.checks.some(c=>c.id==='concurrency_release'));
});
