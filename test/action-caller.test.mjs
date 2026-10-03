import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createActionProtection} from '../actions.mjs';

test('caller reporting is opt-in, scoped, stable across phases, and excludes raw identity',async t=>{
 const reports=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;assert.ok(!raw.includes('private-'));reports.push(JSON.parse(raw));res.writeHead(202);res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const caller={schema:1,subject:'private-subject',tenant:'private-tenant',issuer:'private-issuer',authenticationMethod:'session',expiresAt:Date.now()+60000,scopes:[]};
 async function run({identity=caller,reportCaller=true,propertyId='11111111-1111-4111-8111-111111111111',subjectSecret='x'.repeat(32),authorize=true}={}){
  const offset=reports.length;
  const p=createActionProtection({policyVersion:'v1',sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${server.address().port}`,propertyId,subjectSecret,webdecoyKey:'fixture',reportCaller},authenticate:()=>identity,actions:{read:{requiredScopes:[],validate:()=>true,authorize:()=>authorize,execute:()=>42}}});
  try{await p.run('read',{subject:'forged'},{});}catch(e){assert.ok([401,403].includes(e.status));}await p.flush();return reports.slice(offset);
 }
 const first=await run();assert.equal(first.length,2);assert.match(first[0].tool_action.caller.id,/^[a-f0-9]{64}$/);assert.deepEqual(first[0].tool_action.caller,first[1].tool_action.caller);
 assert.deepEqual((await run())[0].tool_action.caller,first[0].tool_action.caller);
 for(const key of ['subject','issuer','tenant'])assert.notEqual((await run({identity:{...caller,[key]:'private-other'}}))[0].tool_action.caller.id,first[0].tool_action.caller.id);
 for(const change of [{propertyId:'22222222-2222-4222-8222-222222222222'},{subjectSecret:'y'.repeat(32)}])assert.notEqual((await run(change))[0].tool_action.caller.id,first[0].tool_action.caller.id);
 assert.equal((await run({identity:null}))[0].tool_action.caller,undefined);
 assert.equal((await run({reportCaller:false}))[0].tool_action.caller,undefined);
 assert.deepEqual((await run({authorize:false}))[0].tool_action.caller,first[0].tool_action.caller);
});
