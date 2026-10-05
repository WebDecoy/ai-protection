import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMCPControls} from '../scripts/inspect-mcp-controls.mjs';
const runtime={webdecoyUrl:'https://ai-protection.example',webdecoyKey:'private-api-key',propertyId:'11111111-1111-4111-8111-111111111111',subjectSecret:'private-subject-secret-'.repeat(3)};
function options(limits){return {resource:'http://127.0.0.1:8093/mcp',authorizationServer:'https://issuer.example/',policyVersion:'v1',sharedRuntime:runtime,authenticate:()=>assert.fail('authentication executed'),tools:{read:{description:'Read',inputSchema:{type:'object'},requiredScopes:['private-scope'],validate:()=>assert.fail('validation executed'),authorize:()=>assert.fail('authorization executed'),execute:()=>assert.fail('tool executed'),...(limits?{limits}:{})}}};}
test('default observe/open and unconfigured controls are explicit without secrets',()=>{
 const r=inspectMCPControls(options({callerQuota:{ruleId:'private_rule',limit:3,windowSeconds:60}}));assert.equal(r.status,'valid_configuration');
 const quota=r.tools[0].controls.find(x=>x.kind==='callerQuota');assert.deepEqual([quota.mode,quota.failureMode,quota.exhaustion,quota.unavailable],['observe','open','observe','allow']);
 assert.equal(r.tools[0].controls.find(x=>x.kind==='work').status,'unconfigured');assert.equal(r.reporting.delivery,'not_verified');
 for(const secret of ['private-api-key','private-subject-secret','private-scope','private_rule'])assert.ok(!JSON.stringify(r).includes(secret));
});
for(const mode of ['observe','enforce'])for(const failureMode of ['open','closed'])test(`${mode}/${failureMode} matches actual control semantics`,()=>{
 const r=inspectMCPControls(options({callerQuota:{ruleId:'quota',limit:2,windowSeconds:60,mode,failureMode},work:{ruleId:'work',maxUnits:3,windowSeconds:60,limits:{caller:6},mode,failureMode}}));assert.equal(r.status,'valid_configuration');
 for(const control of r.tools[0].controls.filter(c=>c.status==='configured')){assert.equal(control.exhaustion,mode==='enforce'?'deny':'observe');assert.equal(control.unavailable,mode==='enforce'&&failureMode==='closed'?'deny':'allow');}
});
test('adapter validates tool-pause metadata while inspection makes no network calls',()=>{
 const o=options();o.discovery={serverId:'fixture'};o.sharedRuntime={...runtime,toolPause:true};const r=inspectMCPControls(o);assert.equal(r.status,'valid_configuration');assert.equal(r.pauses.tool,'configured');assert.equal(r.pauses.failureMode,'open');
});
test('invalid limits fail diagnostics without reflecting private values',()=>{
 const o=options({callerQuota:{ruleId:'bad',limit:-1,windowSeconds:60}});o.sharedRuntime.webdecoyKey='private-api-key';const r=inspectMCPControls(o);assert.equal(r.status,'invalid_configuration');assert.ok(!JSON.stringify(r).includes('private-api-key'));
});
