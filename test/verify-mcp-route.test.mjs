import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createProtectedMCPHandler} from '../mcp.mjs';
import {verifyMCPRoute} from '../scripts/verify-mcp-route.mjs';
async function fixture(t,{authBroken=false}={}){
 let handler,calls=0;const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const resource=`http://127.0.0.1:${server.address().port}/mcp`,token='private-owned-token';
 handler=createProtectedMCPHandler({resource,authorizationServer:'https://issuer.example/',policyVersion:'v1',authenticate:async request=>{
  if(!authBroken&&request.headers.get('authorization')!==`Bearer ${token}`)throw Error('Invalid');
  return {schema:1,subject:'user',tenant:'tenant',issuer:'fixture',authenticationMethod:'session',scopes:[],expiresAt:Date.now()+60000};
 },tools:{read:{description:'safe',inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return {content:[]};}}}});
 return {resource,token,calls:()=>calls};
}
test('official client verifies selected route without invoking tools or leaking tokens',async t=>{
 const f=await fixture(t),r=await verifyMCPRoute(f);assert.equal(r.passed,true);assert.equal(r.toolCallsSent,0);assert.equal(f.calls(),0);assert.equal(r.checks.at(-1).advertisedTools,1);assert.ok(!JSON.stringify(r).includes(f.token));assert.ok(r.unverified.includes('tool authorization and tenant ownership'));
});
test('unguarded route fails before the valid token is sent',async t=>{
 const f=await fixture(t,{authBroken:true}),r=await verifyMCPRoute(f);assert.equal(r.passed,false);assert.equal(r.checks.at(-1).name,'missing_credentials');assert.equal(f.calls(),0);
});
test('invalid real credential cannot pass protocol verification',async t=>{
 const f=await fixture(t),r=await verifyMCPRoute({...f,token:'wrong'});assert.equal(r.passed,false);assert.equal(r.checks.at(-1).name,'official_client');assert.equal(f.calls(),0);
});
test('nonlocal and unintended resource paths are refused',async()=>{
 for(const resource of ['https://api.example/mcp','http://localhost/mcp','http://127.0.0.1/admin','http://user:secret@127.0.0.1/mcp']){
  const r=await verifyMCPRoute({resource,token:'secret'});assert.equal(r.passed,false);assert.equal(r.checks[0].status,'unconfigured');assert.ok(!JSON.stringify(r).includes('secret'));
 }
});
for(const mode of ['redirect','oversized','stalled'])test(`bounded probe rejects ${mode} responses`,async t=>{
 let calls=0;const server=createServer((req,res)=>{calls++;if(mode==='redirect'){res.writeHead(302,{Location:'/unexpected'});res.end();}else if(mode==='oversized'){res.writeHead(401);res.end('x'.repeat(66000));}else{res.writeHead(401);res.write('waiting');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const r=await verifyMCPRoute({resource:`http://127.0.0.1:${server.address().port}/mcp`,token:'secret',timeoutMs:100});assert.equal(r.passed,false);assert.equal(calls,1);
});
