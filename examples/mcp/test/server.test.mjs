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
async function fixture(t,{blocked=false,sharedRuntime,discovery,inputSchema,annotations,registry,decoys,limits}={}){
 let handler;const http=createServer((req,res)=>{void handler(req,res);});
 await new Promise(r=>http.listen(0,'127.0.0.1',r));const resource=`http://127.0.0.1:${http.address().port}/mcp`;
 let reads=0,exports=0,cancelled=0;const events=[];let started;const startedPromise=new Promise(r=>started=r);
 const authenticate=createAuth0Authenticator({issuer,audience:resource,fetcher:async()=>Response.json({keys:[jwk]}),resolveTenant:({organizationId})=>organizationId==='org_a'?'a':organizationId==='org_b'?'b':null});
 handler=createProtectedMCPHandler({sharedRuntime,discovery,decoys,resource,authorizationServer:issuer,authenticate,policyVersion:'records_v1',onEvent:e=>events.push(e),tools:registry??{
  'records.read':{limits,annotations,description:'Read an owned record',inputSchema:inputSchema??{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},requiredScopes:['records:read'],validate:args=>Object.keys(args).length===1&&typeof args.id==='string',authorize:({caller,args})=>caller.tenant===args.id,execute:async({signal})=>{reads++;started();if(blocked)await new Promise((_,reject)=>{if(signal.aborted){cancelled++;reject(signal.reason);}else signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true});});return {content:[{type:'text',text:'owned record'}]};}},
  'records.export':{description:'Export records',inputSchema:{type:'object'},requiredScopes:['records:export'],validate:()=>true,authorize:()=>false,execute:()=>{exports++;return {content:[]};}},
 }});
 t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
 const token=async(overrides={})=>new SignJWT({sub:'reader',iss:issuer,aud:resource,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,scope:'records:read',org_id:'org_a',...overrides}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(keys.privateKey);
 const post=async(body,{bearer,headers={},signal}={})=>{if(bearer===undefined)bearer=await token();return fetch(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(bearer?{Authorization:'Bearer '+bearer}:{}),...headers},body:JSON.stringify(body),signal});};
 return {resource,post,token,events,flush:()=>handler.flush(),counts:()=>({reads,exports,cancelled}),started:startedPromise};
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
test('application permission cannot be bypassed with sufficient OAuth scope',async t=>{const f=await fixture(t);const r=await result(await f.post(call('records.export',{}),{bearer:await f.token({scope:'records:read records:export'})}));assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/permission_denied/);assert.equal(r.result._meta['webdecoy.com/action-error'].status,403);assert.equal(f.counts().exports,0);});
test('tenant crossing and malformed arguments execute zero callbacks',async t=>{const f=await fixture(t);for(const args of [{id:'b'},{id:'a',tenant:'a'},{id:42}]){const r=await result(await f.post(call('records.read',args)));assert.equal(r.result.isError,true);}assert.equal(f.counts().reads,0);});
test('wrong audience, issuer and expired tokens rejected at HTTP boundary',async t=>{const f=await fixture(t);for(const claims of [{aud:'other-api'},{iss:'https://wrong.example/'},{exp:1}]){const r=await f.post(call('records.read'),{bearer:await f.token(claims)});assert.equal(r.status,401);}assert.equal(f.counts().reads,0);});
test('forged origin, session and unsupported operations cannot dispatch',async t=>{const f=await fixture(t);assert.equal((await f.post(call('records.read'),{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await f.post(call('records.read'),{headers:{'Mcp-Session-Id':'forged'}})).status,400);const r=await result(await f.post({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'private://record'}}));assert.equal(r.error.code,-32601);assert.equal(f.counts().reads,0);});
test('disconnect cancels running tool and never retries',async t=>{const f=await fixture(t,{blocked:true});const c=new AbortController();const pending=f.post(call('records.read'),{signal:c.signal});await f.started;c.abort();await pending.then(r=>r.text()).catch(()=>{});for(let i=0;i<50&&!f.counts().cancelled;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.counts(),{reads:1,exports:0,cancelled:1});assert.equal(f.events.at(-1).outcome,'unknown');});

test('MCP cancellation is bound to authenticated caller, tenant and client',async t=>{
 const f=await fixture(t,{blocked:true});const pending=f.post(call('records.read')).then(r=>r.text());await f.started;
 const notification={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}};
 for(const claims of [{org_id:'org_b'},{sub:'other-reader'},{azp:'other-client'}]){
  const foreign=await f.post(notification,{bearer:await f.token(claims)});assert.equal(foreign.status,202);assert.equal(f.counts().cancelled,0);
 }
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

async function reportingFixture(t,status=202){
 const reports=[];
 const http=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;reports.push(JSON.parse(raw));res.writeHead(status);res.end();});
 await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
 return {reports,sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${http.address().port}`,webdecoyKey:'test-key',propertyId:'11111111-1111-4111-8111-111111111111',subjectSecret:'a'.repeat(32)}};
}
test('opt-in discovery reports only advertised names and hashes, before any execution',async t=>{
 const sink=await reportingFixture(t);const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'records'}});
 const reply=await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));
 assert.deepEqual(reply.result.tools.map(t=>t.name),['records.read']);await f.flush();
 assert.equal(f.counts().reads,0);assert.equal(sink.reports.length,1);
 const r=sink.reports[0];assert.equal(r.schema,3);assert.equal(r.action,'tool_discovery');
 assert.deepEqual(Object.keys(r).sort(),['action','request_id','schema','timestamp','tool_catalog']);
 assert.deepEqual(Object.keys(r.tool_catalog).sort(),['server_id','source','tools']);
 assert.equal(r.tool_catalog.server_id,'records');assert.equal(r.tool_catalog.source,'tools_list');
 assert.equal(r.tool_catalog.tools.length,1);assert.deepEqual(Object.keys(r.tool_catalog.tools[0]).sort(),['effect','name','permissions','schema_hash']);
 assert.deepEqual(r.tool_catalog.tools[0].permissions,{schema:1,required_scopes:1,application_authorization:true,additional_policy:false});
 assert.match(r.tool_catalog.tools[0].schema_hash,/^[a-f0-9]{64}$/);
 const raw=JSON.stringify(r);for(const secret of ['reader','org_a','owned record','inputSchema','description','requiredScopes','test-key'])assert.equal(raw.includes(secret),false);
 const denied=await f.post({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{bearer:null});assert.equal(denied.status,401);await f.flush();assert.equal(sink.reports.length,1);
});
test('discovery defaults off and reporter outage never denies tool listing',async t=>{
 const sink=await reportingFixture(t,503);const off=await fixture(t,{sharedRuntime:sink.sharedRuntime});
 await result(await off.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await off.flush();assert.equal(sink.reports.length,0);
 const on=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'records'}});
 const r=await result(await on.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));assert.equal(r.result.tools.length,1);await on.flush();assert.equal(sink.reports.length,1);
});


test('schema hashing ignores object key order but detects schema edits',async t=>{
 const sink=await reportingFixture(t);
 for(const inputSchema of [{type:'object',properties:{id:{type:'string'}}},{properties:{id:{type:'string'}},type:'object'},{type:'object',properties:{id:{type:'number'}}}]){
  const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'stable'},inputSchema});
  await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await f.flush();
 }
 assert.equal(sink.reports.length,3);
 const hashes=sink.reports.map(r=>r.tool_catalog.tools[0].schema_hash);
 assert.equal(hashes[0],hashes[1]);assert.notEqual(hashes[0],hashes[2]);
});

async function awaitReports(sink,count){
 for(let i=0;i<200&&sink.reports.length<count;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(sink.reports.length,count);
}
test('direct MCP calls carry registered server/schema before listing, including scope denials',async t=>{
 const sink=await reportingFixture(t);const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'records'}});
 await result(await f.post(call('records.read')));await awaitReports(sink,2);
 for(const r of sink.reports){assert.equal(r.schema,2);assert.equal(r.tool_action.tool_schema.server_id,'records');assert.match(r.tool_action.tool_schema.hash,/^[a-f0-9]{64}$/);}
 assert.equal(sink.reports[0].tool_action.action_id,sink.reports[1].tool_action.action_id);
 assert.equal(sink.reports.filter(r=>r.schema===3).length,0);
 await result(await f.post({jsonrpc:'2.0',id:3,method:'tools/list',params:{}}));await f.flush();await awaitReports(sink,3);
 const catalog=sink.reports.find(r=>r.schema===3);
 assert.equal(catalog.tool_catalog.tools[0].schema_hash,sink.reports[0].tool_action.tool_schema.hash);
 assert.equal((await f.post(call('records.export',{}))).status,403);await awaitReports(sink,4);
 const denied=sink.reports.find(r=>r.tool_action?.outcome==='not_attempted');
 assert.equal(denied.tool_action.name,'records.export');assert.equal(denied.tool_action.tool_schema.server_id,'records');assert.equal(f.counts().exports,0);
 const unknown=await result(await f.post(call('caller_supplied_private_name')));assert.equal(unknown.error.code,-32602);
 assert.ok(!JSON.stringify(sink.reports).includes('caller_supplied_private_name'));
});
test('MCP action schema evidence stays off without discovery',async t=>{
 const sink=await reportingFixture(t);const f=await fixture(t,{sharedRuntime:sink.sharedRuntime});
 await result(await f.post(call('records.read')));await awaitReports(sink,2);
 for(const r of sink.reports)assert.equal(r.tool_action.tool_schema,undefined);
});


test('MCP hints round-trip while hosted evidence stays advisory and sanitized',async t=>{
 const sink=await reportingFixture(t);const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'records'},annotations:{readOnlyHint:true,title:'private-title'}});
 const listed=await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await f.flush();
 assert.deepEqual(listed.result.tools[0].annotations,{readOnlyHint:true});
 assert.deepEqual(sink.reports[0].tool_catalog.tools[0].effect,{schema:1,level:'read_only',reason:'annotation_read_only'});
 await result(await f.post(call('records.read')));await awaitReports(sink,3);
 assert.equal(f.counts().reads,1);
 for(const r of sink.reports.filter(r=>r.schema===2))assert.deepEqual(r.tool_action.tool_schema.effect,{schema:1,level:'read_only',reason:'annotation_read_only'});
 assert.ok(!JSON.stringify(sink.reports).includes('private-title'));
});
test('maximum registry advertisements stay within runtime body bounds',async t=>{
 const sink=await reportingFixture(t);
 const registry=Object.fromEntries(Array.from({length:128},(_,i)=>['t'+String(i).padStart(3,'0')+'x'.repeat(92),{description:'test',inputSchema:{type:'object'},annotations:{destructiveHint:true},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>({content:[]})}]));
 const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'s'.repeat(96)},registry});
 const listed=await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));assert.equal(listed.result.tools.length,128);await f.flush();
 assert.equal(sink.reports.flatMap(r=>r.tool_catalog.tools).length,128);
 for(const r of sink.reports){assert.ok(Buffer.byteLength(JSON.stringify(r))<=32768);assert.equal(r.tool_catalog.tools[0].effect.level,'destructive');}
});

test('scope-free tool reports policy presence without weakening application denial',async t=>{
 const sink=await reportingFixture(t);let executions=0;
 const registry={delete_record:{description:'fixture',inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>false,policy:()=>true,execute:()=>{executions++;return {content:[]};}}};
 const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'permissions'},registry});
 const listed=await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await f.flush();
 assert.equal(listed.result.tools.length,1);
 const expected={schema:1,required_scopes:0,application_authorization:true,additional_policy:true};
 assert.deepEqual(sink.reports[0].tool_catalog.tools[0].permissions,expected);
 const denied=await result(await f.post(call('delete_record',{})));assert.equal(denied.result.isError,true);await awaitReports(sink,2);
 assert.deepEqual(sink.reports[1].tool_action.tool_schema.permissions,expected);assert.equal(executions,0);
});

test('explicit decoys are scoped, quietly deny, and never execute customer work',async t=>{
 const sink=await reportingFixture(t);
 const decoys={billing_export_ledger:{description:'Internal ledger export',visibility:'advertised'},admin_rotate_keys:{description:'Internal key rotation',visibility:'unadvertised'}};
 const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'decoy_server'},decoys});
 decoys.admin_rotate_keys.visibility='advertised'; // startup snapshot stays unadvertised
 const listed=await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await f.flush();
 assert.deepEqual(listed.result.tools.map(t=>t.name),['records.read','billing_export_ledger']);
 assert.ok(!JSON.stringify(listed).includes('decoy'));assert.equal(sink.reports.filter(r=>r.schema===2).length,0);
 assert.equal((await f.post(call('billing_export_ledger',{}),{bearer:null})).status,401);await f.flush();assert.equal(sink.reports.length,1);
 const catalog=sink.reports[0].tool_catalog.tools;assert.equal(catalog.find(t=>t.name==='billing_export_ledger').decoy,'advertised');assert.equal(catalog.find(t=>t.name==='records.read').decoy,undefined);
 for(const name of ['billing_export_ledger','admin_rotate_keys']){
  const response=await result(await f.post(call(name,{secret:'private-argument'})));
  assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/permission_denied/);assert.equal(response.result._meta['webdecoy.com/action-error'].reason,'permission_denied');assert.ok(!JSON.stringify(response).includes('"decoy"'));
 }
 await awaitReports(sink,3);
 const trips=sink.reports.filter(r=>r.schema===2);assert.equal(trips.length,2);
 for(const r of trips){assert.equal(r.handler_attempted,false);assert.equal(r.tool_action.outcome,'not_attempted');assert.equal(r.tool_action.tool_schema.permissions,undefined);assert.equal(r.tool_action.tool_schema.effect,undefined);assert.ok(['advertised','unadvertised'].includes(r.tool_action.tool_schema.decoy));}
 assert.ok(!JSON.stringify(sink.reports).includes('private-argument'));assert.deepEqual(f.counts(),{reads:0,exports:0,cancelled:0});
 await result(await f.post(call('records.read')));assert.equal(f.counts().reads,1);
});
test('decoys reject collisions, callbacks, oversized registries and missing reporting',async t=>{
 const sink=await reportingFixture(t);
 const base={resource:'https://fixture.test/mcp',authorizationServer:'https://issuer.test',authenticate:async()=>({}),policyVersion:'v1',tools:{real:{description:'real',inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>({content:[]})}},sharedRuntime:sink.sharedRuntime,discovery:{serverId:'test'}};
 const d={description:'Internal fixture',visibility:'unadvertised'};
 for(const decoys of [{real:d},{fake:{...d,execute:()=>{throw Error('must not run');}}},{fake:{...d,visibility:'public'}},Object.fromEntries(Array.from({length:9},(_,i)=>['d'+i,d]))])assert.throws(()=>createProtectedMCPHandler({...base,decoys}));
 assert.throws(()=>createProtectedMCPHandler({...base,decoys:{fake:d},discovery:undefined}));
 assert.doesNotThrow(()=>createProtectedMCPHandler(base));
});

test('reporting outage cannot turn a decoy into executable work',async t=>{
 const sink=await reportingFixture(t,503);const f=await fixture(t,{sharedRuntime:sink.sharedRuntime,discovery:{serverId:'fixture'},decoys:{internal:{description:'Internal fixture',visibility:'unadvertised'}}});
 const denied=await result(await f.post(call('internal',{})));assert.match(denied.result.content[0].text,/permission_denied/);assert.equal(f.counts().reads,0);
 await awaitReports(sink,1);assert.equal(sink.reports[0].handler_attempted,false);
 await result(await f.post(call('records.read')));assert.equal(f.counts().reads,1);await awaitReports(sink,3);
});

test('opt-in enumeration attribution matches action pseudonyms and reports empty listings',async t=>{
 const sink=await reportingFixture(t);const sharedRuntime={...sink.sharedRuntime,reportCaller:true};
 const f=await fixture(t,{sharedRuntime,discovery:{serverId:'records'}});
 await result(await f.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await f.flush();
 await result(await f.post(call('records.read',{id:'a'})));await awaitReports(sink,3);
 const catalog=sink.reports.find(r=>r.tool_catalog).tool_catalog;
 const action=sink.reports.find(r=>r.tool_action).tool_action;
 assert.deepEqual(catalog.caller,action.caller);assert.match(catalog.caller.id,/^[a-f0-9]{64}$/);
 for(const secret of ['reader','org_a','test-key'])assert.equal(JSON.stringify(catalog).includes(secret),false);
 const empty=await fixture(t,{sharedRuntime,discovery:{serverId:'empty'},registry:{hidden:{description:'Hidden',inputSchema:{type:'object'},requiredScopes:['hidden'],validate:()=>true,authorize:()=>false,execute:()=>({content:[]})}}});
 await result(await empty.post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));await empty.flush();
 const listing=sink.reports.find(r=>r.tool_catalog?.server_id==='empty').tool_catalog;
 assert.deepEqual(listing.tools,[]);assert.ok(listing.caller);
});

test('shared address and unavailable runtime do not merge caller authority',async t=>{
 const sink=await reportingFixture(t,503);
 const f=await fixture(t,{sharedRuntime:{...sink.sharedRuntime,reportCaller:true,callerPause:true,callerPauseTimeoutMs:100}});
 const a=await f.token(),b=await f.token({sub:'second-reader',org_id:'org_b'});
 for(const [bearer,id] of [[a,'a'],[b,'b']]){
   const reply=await result(await f.post(call('records.read',{id}),{bearer}));
   assert.equal(reply.result.content[0].text,'owned record');
 }
 const crossing=await result(await f.post(call('records.read',{id:'a'}),{bearer:b}));
 assert.equal(crossing.result.isError,true);
 for(const claims of [{exp:1},{iss:'https://wrong.example/'},{aud:'wrong'},{act:{sub:'delegate'}}]){
   assert.equal((await f.post(call('records.read'),{bearer:await f.token(claims)})).status,401);
 }
 assert.equal((await f.post(call('records.export',{}),{bearer:a})).status,403);
 assert.equal(f.counts().reads,2);assert.equal(f.counts().exports,0);
 const completed=f.events.filter(e=>e.outcome==='completed');
 assert.equal(new Set(completed.map(e=>e.caller.id)).size,2);
 assert.ok(completed.every(e=>e.checks.some(c=>c.id==='caller_pause'&&c.decision==='unavailable')));
 await f.flush();
});

// Deterministic HTTP state-service contract fixture. Atomic PostgreSQL behavior
// is covered by the runtime suite; this proves MCP client/transport integration.
async function quotaFixture(t) {
 const counts=new Map();let unavailable=false, requests=0;
 const http=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url.endsWith('/reports')){res.writeHead(202);res.end();return;}
  assert.ok(req.url.endsWith('/quota'));
  requests++;
  if(unavailable){res.writeHead(503);res.end();return;}
  const body=JSON.parse(raw),key=body.rule_id+':'+body.subject;
  const count=counts.get(key)??0,allowed=count<body.limit;
  if(allowed)counts.set(key,count+1);
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({schema:1,allowed,reason:allowed?'account_quota_allowed':'account_quota_exceeded',remaining:Math.max(0,body.limit-(counts.get(key)??0)),retry_after_seconds:allowed?0:30,reset_at:Math.floor(Date.now()/1000)+30}));
 });
 await new Promise(r=>http.listen(0,'127.0.0.1',r));
 t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
 return {sharedRuntime:{webdecoyUrl:`http://127.0.0.1:${http.address().port}`,webdecoyKey:'fixture',propertyId:'11111111-1111-4111-8111-111111111111',subjectSecret:'x'.repeat(32)},setUnavailable:value=>{unavailable=value;},requests:()=>requests};
}
const callerLimit=failureMode=>({callerQuota:{ruleId:'mcp_read_v1',limit:1,windowSeconds:60,mode:'enforce',failureMode}});
async function connectClient(t,f,claims={}) {
 const client=new Client({name:'lifecycle-fixture',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(f.resource),{requestInit:{headers:{Authorization:'Bearer '+await f.token(claims)}}}));
 t.after(()=>client.close());return client;
}
test('fresh official MCP clients and replicas cannot reset shared caller allowance',async t=>{
 const state=await quotaFixture(t);
 const a=await fixture(t,{sharedRuntime:state.sharedRuntime,limits:callerLimit('closed')});
 const b=await fixture(t,{sharedRuntime:state.sharedRuntime,limits:callerLimit('closed')});
 const first=await connectClient(t,a);
 assert.equal((await first.callTool({name:'records.read',arguments:{id:'a'}})).content[0].text,'owned record');
 await first.close();
 for(const server of [a,b]){
  const fresh=await connectClient(t,server);
  const denied=await fresh.callTool({name:'records.read',arguments:{id:'a'}});
  assert.equal(denied.isError,true);
  assert.deepEqual(denied._meta['webdecoy.com/action-error'],{reason:'account_quota_exceeded',status:429,retryAfterSeconds:30});
 }
 const other=await connectClient(t,b,{sub:'other-reader'});
 assert.equal((await other.callTool({name:'records.read',arguments:{id:'a'}})).content[0].text,'owned record');
 const tenant=await connectClient(t,b,{org_id:'org_b'});
 assert.equal((await tenant.callTool({name:'records.read',arguments:{id:'b'}})).content[0].text,'owned record');
 assert.equal(a.counts().reads,1);assert.equal(b.counts().reads,2);assert.equal(state.requests(),5);
});
for(const mode of ['open','closed'])test(`MCP state outage ${mode} preserves permissions and recovers without transport reset`,async t=>{
 const state=await quotaFixture(t);state.setUnavailable(true);
 const f=await fixture(t,{sharedRuntime:state.sharedRuntime,limits:callerLimit(mode)});
 const client=await connectClient(t,f);
 const crossed=await client.callTool({name:'records.read',arguments:{id:'b'}});
 assert.equal(crossed.isError,true);assert.equal(crossed._meta['webdecoy.com/action-error'].reason,'permission_denied');
 assert.equal(state.requests(),0);assert.equal(f.counts().reads,0);
 const reply=await client.callTool({name:'records.read',arguments:{id:'a'}});
 if(mode==='closed'){assert.equal(reply.isError,true);assert.equal(reply._meta['webdecoy.com/action-error'].status,503);}
 else assert.equal(reply.content[0].text,'owned record');
 assert.equal(f.counts().reads,mode==='closed'?0:1);
 state.setUnavailable(false);
 assert.equal((await client.callTool({name:'records.read',arguments:{id:'a'}})).content[0].text,'owned record');
 const denied=await client.callTool({name:'records.read',arguments:{id:'a'}});
 assert.equal(denied._meta['webdecoy.com/action-error'].status,429);
 assert.equal(f.counts().reads,mode==='closed'?1:2);
});

test('stateless SSE responses correlate string and numeric IDs without session or resume authority',async t=>{
 const f=await fixture(t);
 for(const id of ['request-a',17]){
  const response=await f.post({...call('records.read'),id});
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  assert.equal(response.headers.get('mcp-session-id'),null);
  const reply=await result(response);assert.equal(reply.id,id);assert.equal(reply.result.content[0].text,'owned record');
 }
 assert.equal((await f.post(call('records.read'),{headers:{'Last-Event-ID':'invented-resume'}})).status,400);
 assert.equal(f.counts().reads,2);
});
