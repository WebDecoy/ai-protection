import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createProtectedMCPHandler} from '../dist/server.js';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createAuth0Authenticator} from '../../auth0/authenticate.mjs';
const keys=await generateKeyPair('RS256');const jwk={...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
const issuer='https://fixture.auth0.com/';
async function fixture(t,{blocked=false}={}){
 let handler;const http=createServer((req,res)=>{void handler(req,res);});
 await new Promise(r=>http.listen(0,'127.0.0.1',r));const resource=`http://127.0.0.1:${http.address().port}/mcp`;
 let reads=0,exports=0,cancelled=0;const events=[];let started;const startedPromise=new Promise(r=>started=r);
 const authenticate=createAuth0Authenticator({issuer,audience:resource,fetcher:async()=>Response.json({keys:[jwk]}),resolveTenant:({organizationId})=>organizationId==='org_a'?'a':organizationId==='org_b'?'b':null});
 handler=createProtectedMCPHandler({resource,authorizationServer:issuer,authenticate,policyVersion:'records_v1',onEvent:e=>events.push(e),tools:{
  'records.read':{description:'Read an owned record',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},requiredScopes:['records:read'],validate:args=>Object.keys(args).length===1&&typeof args.id==='string',authorize:({caller,args})=>caller.tenant===args.id,execute:async({signal})=>{reads++;started();if(blocked)await new Promise((_,reject)=>{if(signal.aborted){cancelled++;reject(signal.reason);}else signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true});});return {content:[{type:'text',text:'owned record'}]};}},
  'records.export':{description:'Export records',inputSchema:{type:'object'},requiredScopes:['records:export'],validate:()=>true,authorize:()=>false,execute:()=>{exports++;return {content:[]};}},
 }});
 t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
 const token=async(overrides={})=>new SignJWT({sub:'reader',iss:issuer,aud:resource,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,scope:'records:read',org_id:'org_a',...overrides}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(keys.privateKey);
 const post=async(body,{bearer,headers={},signal}={})=>{if(bearer===undefined)bearer=await token();return fetch(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(bearer?{Authorization:'Bearer '+bearer}:{}),...headers},body:JSON.stringify(body),signal});};
 return {resource,post,token,events,counts:()=>({reads,exports,cancelled}),started:startedPromise};
}
const call=(name,args={id:'a'})=>({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});
async function result(response){assert.equal(response.status,200);const s=await response.text();const lines=s.split('\n').filter(x=>x.startsWith('data: '));return JSON.parse(lines.at(-1).slice(6));}
test('real MCP client initializes, sees scoped tools, and receives original tool result',async t=>{
 const f=await fixture(t);const client=new Client({name:'fixture',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(f.resource),{requestInit:{headers:{Authorization:'Bearer '+await f.token()}}}));t.after(()=>client.close());
 const listed=await client.listTools();assert.deepEqual(listed.tools.map(t=>t.name),['records.read']);
 const r=await client.callTool({name:'records.read',arguments:{id:'a'}});assert.equal(r.content[0].text,'owned record');assert.equal(f.counts().reads,1);
});
test('missing auth advertises resource metadata without dispatch',async t=>{const f=await fixture(t);const r=await f.post(call('records.read'),{bearer:null});assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/resource_metadata=/);const metadata=await(await fetch(new URL('/.well-known/oauth-protected-resource/mcp',f.resource))).json();assert.equal(metadata.resource,f.resource);assert.deepEqual(metadata.authorization_servers,[issuer]);assert.equal(f.counts().reads,0);});
test('direct hidden tool gets HTTP scope challenge and never executes',async t=>{const f=await fixture(t);const r=await f.post(call('records.export',{}));assert.equal(r.status,403);assert.match(r.headers.get('www-authenticate'),/insufficient_scope.*records:export/);assert.equal(f.counts().exports,0);assert.equal(f.events.at(-1).reason,'missing_scope');});
test('application permission cannot be bypassed with sufficient OAuth scope',async t=>{const f=await fixture(t);const r=await result(await f.post(call('records.export',{}),{bearer:await f.token({scope:'records:read records:export'})}));assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/permission_denied/);assert.equal(f.counts().exports,0);});
test('tenant crossing and malformed arguments execute zero callbacks',async t=>{const f=await fixture(t);for(const args of [{id:'b'},{id:'a',tenant:'a'},{id:42}]){const r=await result(await f.post(call('records.read',args)));assert.equal(r.result.isError,true);}assert.equal(f.counts().reads,0);});
test('wrong audience, issuer and expired tokens rejected at HTTP boundary',async t=>{const f=await fixture(t);for(const claims of [{aud:'other-api'},{iss:'https://wrong.example/'},{exp:1}]){const r=await f.post(call('records.read'),{bearer:await f.token(claims)});assert.equal(r.status,401);}assert.equal(f.counts().reads,0);});
test('forged origin, session and unsupported operations cannot dispatch',async t=>{const f=await fixture(t);assert.equal((await f.post(call('records.read'),{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await f.post(call('records.read'),{headers:{'Mcp-Session-Id':'forged'}})).status,400);const r=await result(await f.post({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'private://record'}}));assert.equal(r.error.code,-32601);assert.equal(f.counts().reads,0);});
test('disconnect cancels running tool and never retries',async t=>{const f=await fixture(t,{blocked:true});const c=new AbortController();const pending=f.post(call('records.read'),{signal:c.signal});await f.started;c.abort();await pending.then(r=>r.text()).catch(()=>{});for(let i=0;i<50&&!f.counts().cancelled;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.counts(),{reads:1,exports:0,cancelled:1});assert.equal(f.events.at(-1).outcome,'unknown');});

test('MCP cancellation is bound to authenticated caller, tenant and client',async t=>{
 const f=await fixture(t,{blocked:true});const pending=f.post(call('records.read')).then(r=>r.text());await f.started;
 const notification={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}};
 const foreign=await f.post(notification,{bearer:await f.token({org_id:'org_b'})});assert.equal(foreign.status,202);assert.equal(f.counts().cancelled,0);
 const own=await f.post(notification);assert.equal(own.status,202);await pending;
 assert.deepEqual(f.counts(),{reads:1,exports:0,cancelled:1});
});
test('concurrent requests keep caller contexts separate',async t=>{
 const f=await fixture(t);const tokens=[await f.token(),await f.token({org_id:'org_b'})];
 const replies=await Promise.all(tokens.map((bearer,i)=>f.post(call('records.read',{id:i?'b':'a'}),{bearer}).then(result)));
 for(const r of replies)assert.equal(r.result.content[0].text,'owned record');assert.equal(f.counts().reads,2);
});
test('active request IDs cannot be overwritten',async t=>{
 const f=await fixture(t,{blocked:true});const c=new AbortController();const pending=f.post(call('records.read'),{signal:c.signal}).then(r=>r.text()).catch(()=>{});await f.started;
 assert.equal((await f.post(call('records.read'))).status,409);assert.equal(f.counts().reads,1);c.abort();await pending;
});
test('oversized bodies and unknown tools never execute',async t=>{const f=await fixture(t);const large=await f.post(call('records.read',{id:'a'.repeat(17000)}));assert.equal(large.status,413);const unknown=await result(await f.post(call('not_registered')));assert.equal(unknown.error.code,-32602);assert.equal(f.counts().reads,0);});
test('unsupported protocol versions and session methods fail explicitly',async t=>{const f=await fixture(t);const r=await f.post(call('records.read'),{headers:{'MCP-Protocol-Version':'2099-01-01'}});assert.equal(r.status,400);for(const method of ['GET','DELETE'])assert.equal((await fetch(f.resource,{method})).status,405);assert.equal(f.counts().reads,0);});
