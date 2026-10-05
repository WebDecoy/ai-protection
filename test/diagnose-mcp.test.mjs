import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {diagnoseMCP} from '../scripts/diagnose-mcp.mjs';
const propertyId='11111111-1111-4111-8111-111111111111',key='private-diagnostic-key';
const config={schema:1,mode:'observe',property_id:propertyId,enforce:true,observe:true};
async function fixture(t,handler){const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});return `http://127.0.0.1:${server.address().port}`;}
test('one read-only request verifies binding without claiming tool enforcement',async t=>{
 let requests=0;const baseURL=await fixture(t,(req,res)=>{requests++;assert.equal(req.method,'GET');assert.equal(req.url,'/api/v1/sdk/ai-abuse/config');assert.equal(req.headers.authorization,'Bearer '+key);res.setHeader('content-type','application/json');res.end(JSON.stringify(config));});
 const report=await diagnoseMCP({baseURL,key,propertyId});assert.equal(requests,1);assert.equal(report.checks[0].status,'verified');assert.equal(report.runtime.configuredPropertyMode,'observe');assert.equal(report.coverage,'not_verified');assert.equal(report.effectiveToolControls,'not_verified');assert.ok(!JSON.stringify(report).includes(key));
});
for(const [status,want] of [[400,'unconfigured'],[401,'rejected'],[403,'rejected'],[404,'unsupported'],[503,'unavailable']])test(`HTTP ${status} is explicit and never reflects response secrets`,async t=>{
 const baseURL=await fixture(t,(_,res)=>{res.writeHead(status);res.end(key);});const r=await diagnoseMCP({baseURL,key,propertyId});assert.equal(r.checks[0].status,want);assert.ok(!JSON.stringify(r).includes(key));
});
test('property mismatch and invalid contracts cannot be reported verified',async()=>{
 for(const body of [{...config,property_id:'22222222-2222-4222-8222-222222222222'},{...config,schema:2},{...config,mode:'off'},null]){
  const r=await diagnoseMCP({key,propertyId},async()=>Response.json(body));assert.notEqual(r.checks[0].status,'verified');
 }
});
test('redirects are not followed and stalled bodies time out without retry',async t=>{
 let requests=0;const baseURL=await fixture(t,(req,res)=>{requests++;if(req.url.includes('config')){res.writeHead(302,{Location:'/secret-target'});res.end();}else{assert.fail('redirect followed');}});
 assert.equal((await diagnoseMCP({baseURL,key,propertyId})).checks[0].reason,'request_failed');assert.equal(requests,1);
 const stalled=await fixture(t,(_,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
 assert.equal((await diagnoseMCP({baseURL:stalled,key,propertyId,timeoutMs:30})).checks[0].reason,'request_failed');
});
test('response bounds and invalid configuration are explicit',async()=>{
 const r=await diagnoseMCP({key,propertyId},async()=>new Response('x'.repeat(17000),{headers:{'content-type':'application/json'}}));assert.equal(r.checks[0].reason,'oversized_contract');
 for(const baseURL of ['http://public.example','https://user:pass@example.com','https://example.com/?token=secret']){
  const r=await diagnoseMCP({baseURL,key,propertyId},()=>assert.fail('invalid config sent'));assert.equal(r.checks[0].status,'unconfigured');
 }
});
