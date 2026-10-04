import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createActionProtection,ActionDenied} from '../actions.mjs';
const cases=JSON.parse(readFileSync(new URL('./fixtures/caller-contract-v1.json',import.meta.url),'utf8'));
for(const v of cases)test('shared caller contract: '+v.name,async()=>{
 let calls=0;
 const guard=createActionProtection({policyVersion:'v1',authenticate:()=>v.caller,actions:{read:{
  requiredScopes:['read'],validate:()=>true,authorize:({caller})=>caller.tenant==='tenant-a',
  execute:()=>{calls++;return 'result';}
 }}});
 if(v.reason==='allow')assert.equal(await guard.run('read',v.arguments,{}),'result');
 else await assert.rejects(guard.run('read',v.arguments,{}),e=>e instanceof ActionDenied&&e.reason===v.reason);
 assert.equal(calls,v.reason==='allow'?1:0);
});
test('ill-formed Unicode identity never reaches a callback',async()=>{
 for(const field of ['subject','tenant','issuer','authenticationMethod','clientId','scopes']){
  let calls=0;const caller={...cases[0].caller,[field]:field==='scopes'?['read','\ud800']:'\ud800'};
  const guard=createActionProtection({policyVersion:'v1',authenticate:()=>caller,actions:{read:{requiredScopes:['read'],validate:()=>true,authorize:()=>true,execute:()=>calls++}}});
  await assert.rejects(guard.run('read',{},{}),e=>e.reason==='authentication_required');assert.equal(calls,0);
 }
});
