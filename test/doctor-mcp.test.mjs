import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,symlink,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createProtectedMCPHandler} from '../mcp.mjs';
import {setupMCP} from '../scripts/setup-mcp.mjs';
import {wireMCPRoute} from '../scripts/wire-mcp-route.mjs';
import {detectMCPProject,checkMCPRoute} from '../scripts/doctor-mcp.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const property='7c9e6679-7425-40de-944b-e07fc1f90ae7';
async function sample(t){
 const project=await mkdtemp(join(tmpdir(),'wd-doctor-'));t.after(()=>rm(project,{recursive:true,force:true}));
 await cp(join(root,'examples/mcp-install'),project,{recursive:true});
 await mkdir(join(project,'node_modules/@webdecoy'),{recursive:true});
 await symlink(process.env.WEBDECOY_INSTALL_SDK_ROOT??root,join(project,'node_modules/@webdecoy/ai-protection'),'dir');
 await symlink(join(root,'node_modules/@types'),join(project,'node_modules/@types'),'dir');
 return project;
}
async function project(t,files){
 const dir=await mkdtemp(join(tmpdir(),'wd-detect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [name,text] of Object.entries(files)){await mkdir(join(dir,name,'..'),{recursive:true});await writeFile(join(dir,name),text);}
 return dir;
}
const plan=(resource,checks,extra={})=>({schema:1,resource,callers:{owner:{tokenEnv:'DOCTOR_TOKEN_A'},other:{tokenEnv:'DOCTOR_TOKEN_B'}},checks,...extra});
const env={DOCTOR_TOKEN_A:'owned-a',DOCTOR_TOKEN_B:'owned-b'};

test('detect finds the supported sample layout statically and proposes the next steps',async t=>{
 const dir=await sample(t);
 // Executing this module would leave a file behind; detection must not.
 await writeFile(join(dir,'src/side-effect.ts'),`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir,'executed'))},'x');\n`);
 const before=await detectMCPProject({project:dir});
 await assert.rejects(access(join(dir,'executed')));
 assert.equal(before.executedProjectCode,false);
 assert.equal(before.runtime,'node-esm');
 assert.deepEqual(before.layouts.map(l=>[l.layout,l.support]),[['node-http-mcp','supported']]);
 assert.deepEqual(before.candidates.optionsModules,['src/options.ts']);
 assert.deepEqual(before.candidates.routeFiles,['src/server.ts']);
 assert.deepEqual(before.candidates.nodeServers,['src/start.ts']);
 assert.equal(before.state,'not_integrated');
 assert.deepEqual(before.proposed.map(p=>p.step),['setup','wire','check']);
 assert.match(before.proposed[1].command,/wire-mcp-route\.mjs plan <project> src\/server\.ts src\/webdecoy-mcp\.ts$/);
 // A repeat run on an integrated app proposes only verification.
 await setupMCP({command:'apply',project:dir,optionsFile:'src/options.ts'});
 assert.equal((await detectMCPProject({project:dir})).state,'handler_generated');
 await wireMCPRoute({command:'apply',project:dir,routeFile:'src/server.ts',handlerFile:'src/webdecoy-mcp.ts'});
 const after=await detectMCPProject({project:dir});
 assert.equal(after.state,'wired');assert.deepEqual(after.candidates.wiredRoutes,['src/server.ts']);
 assert.deepEqual(after.proposed.map(p=>p.step),['check']);
});

test('detect names unsupported layouts and uncovered servers with remediation',async t=>{
 const cases=[
  [{'package.json':JSON.stringify({type:'module',dependencies:{next:'16.0.0'}}),'app/route.ts':'export {}'},r=>assert.deepEqual(r.layouts.map(l=>[l.layout,l.support]),[['nextjs','separate_contract']])],
  [{'package.json':JSON.stringify({type:'module',dependencies:{express:'5.0.0','@modelcontextprotocol/sdk':'1.31.0'}}),'src/app.ts':'export {}'},r=>assert.ok(r.unsupported.some(u=>u.layout==='express'&&/protectedMCPHandler/.test(u.remediation)))],
  [{'package.json':JSON.stringify({dependencies:{'@modelcontextprotocol/sdk':'1.31.0'}}),'src/a.ts':'export {}'},r=>{assert.equal(r.runtime,'node-cjs');assert.deepEqual(r.layouts,[]);assert.ok(r.unsupported.some(u=>u.layout==='commonjs'));}],
  [{'go.mod':'module example.com/app\n','main.go':'package main'},r=>{assert.equal(r.runtime,'go');assert.ok(r.unsupported.some(u=>u.layout==='go'));}],
  [{'package.json':JSON.stringify({type:'module',dependencies:{'@modelcontextprotocol/sdk':'1.31.0'}}),'src/raw.ts':"import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';\nconst s=new McpServer({name:'x',version:'1'});\n"},r=>{assert.deepEqual(r.candidates.unwrappedMCPServers,['src/raw.ts']);assert.ok(r.unsupported.some(u=>u.layout==='unwrapped_mcp_server'&&u.file==='src/raw.ts'));assert.equal(r.proposed[0].step,'select_options');}],
 ];
 for(const [files,check] of cases)check(await detectMCPProject({project:await project(t,files)}));
 // Dependencies, build output and symlinks are never scanned.
 const dir=await project(t,{'package.json':JSON.stringify({type:'module'}),'node_modules/x/index.ts':'export const mcpOptions={}','dist/o.ts':'export const mcpOptions={}','outside/o.ts':'export const mcpOptions={}'});
 await mkdir(join(dir,'src'));await symlink(join(dir,'outside/o.ts'),join(dir,'src/link.ts'));
 assert.deepEqual((await detectMCPProject({project:dir})).candidates.optionsModules,['outside/o.ts']);
});

test('check verifies the sample route with independent callback counts',{timeout:30000},async t=>{
 const dir=await sample(t);
 await setupMCP({command:'apply',project:dir,optionsFile:'src/options.ts'});
 await wireMCPRoute({command:'apply',project:dir,routeFile:'src/server.ts',handlerFile:'src/webdecoy-mcp.ts'});
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',dir],{stdio:'pipe'});
 let route;const server=createServer((req,res)=>route(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const resource=`http://127.0.0.1:${server.address().port}/mcp`;
 const {mcpOptions,counters}=await import(pathToFileURL(join(dir,'dist/options.js')));mcpOptions.resource=resource;
 ({route}=await import(pathToFileURL(join(dir,'dist/server.js'))));
 const report=await checkMCPRoute({env,plan:plan(resource,[
  {kind:'allowed',caller:'owner',tool:'read',arguments:{id:'a'}},
  {kind:'allowed',caller:'other',tool:'read',arguments:{id:'b'}},
  {kind:'forbidden',caller:'owner',tool:'admin'},
  {kind:'cross_tenant',caller:'owner',tool:'read',arguments:{id:'b'}},
  {kind:'cross_tenant',caller:'other',tool:'read',arguments:{id:'a'}},
  {kind:'cancellation',caller:'owner',tool:'wait',afterMs:150},
 ],{propertyId:property})});
 assert.equal(report.passed,true,JSON.stringify(report.checks));
 assert.deepEqual(report.checks.map(c=>c.status),Array(6).fill('verified'));
 assert.deepEqual(report.checks[2].observed,{reason:'permission_denied',status:403});
 assert.deepEqual(report.exercised,{routes:['/mcp','/.well-known/oauth-protected-resource/mcp'],tools:['admin','read','wait'],callers:2});
 assert.equal(report.callbacks,'not_observable_out_of_process');
 // The sample's own counters agree with the protocol evidence.
 for(let i=0;i<100&&!counters.cancelled;i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(counters,{reads:2,forbidden:0,waiting:1,cancelled:1});
 const first=report.checks[0].actionId;assert.match(first,/^[0-9a-f-]{36}$/);
 assert.equal(report.dashboard.url,`https://app.webdecoy.com/ai-protection?property=${property}&action=${first}`);
 assert.equal(report.dashboard.individuallyLinked,true);assert.deepEqual(report.dashboard.linkedCheck,{kind:'allowed',tool:'read',actionId:first});
 // Denied calls are linkable too; each call has its own ID.
 assert.match(report.checks[2].actionId,/^[0-9a-f-]{36}$/);assert.equal(new Set(report.checks.filter(c=>c.actionId).map(c=>c.actionId)).size,5);
 assert.ok(Date.parse(report.window.from)<=Date.parse(report.window.to));
 const text=JSON.stringify(report);for(const token of Object.values(env))assert.ok(!text.includes(token),'token leaked');
});

test('check fails a server that skips tenant and permission checks, with remediation',async t=>{
 let handler,calls=0;const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const resource=`http://127.0.0.1:${server.address().port}/mcp`;
 handler=createProtectedMCPHandler({resource,authorizationServer:'https://issuer.example/',policyVersion:'v1',
  authenticate:async request=>{const token=request.headers.get('authorization');if(token!=='Bearer owned-a'&&token!=='Bearer owned-b')throw Error('Invalid');return {schema:1,subject:'s',tenant:token.slice(-1),issuer:'fixture',authenticationMethod:'session',scopes:['read'],expiresAt:Date.now()+60000};},
  tools:{
   // Ownership taken from the caller-supplied argument: the bug the check exists to catch.
   read:{inputSchema:{type:'object'},requiredScopes:['read'],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return {content:[{type:'text',text:'r'}]};}},
   admin:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return {content:[]};}},
   quick:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return {content:[]};}},
   strict:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>false,authorize:()=>false,execute:()=>{calls++;return {content:[]};}},
   deny:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>false,execute:()=>{calls++;return {content:[]};}},
   scoped:{inputSchema:{type:'object'},requiredScopes:['admin'],validate:()=>true,authorize:()=>true,execute:()=>{calls++;return {content:[]};}},
  }});
 const report=await checkMCPRoute({env,plan:plan(resource,[
  {kind:'forbidden',caller:'owner',tool:'admin'},
  {kind:'cross_tenant',caller:'owner',tool:'read',arguments:{id:'b'}},
  {kind:'cancellation',caller:'owner',tool:'quick',afterMs:500},
  {kind:'allowed',caller:'owner',tool:'missing'},
  // Refused, but by input validation: that does not prove the permission control.
  {kind:'forbidden',caller:'owner',tool:'strict'},
  {kind:'allowed',caller:'owner',tool:'deny'},
  // An unknown tool errors without proving any control; a scope gate refuses at HTTP level.
  {kind:'forbidden',caller:'owner',tool:'missing'},
  {kind:'forbidden',caller:'owner',tool:'scoped'},
 ])});
 assert.equal(report.passed,false);
 assert.deepEqual(report.checks.map(c=>c.status),['failed','failed','inconclusive','failed','failed','failed','failed','verified']);
 assert.deepEqual(report.checks[7].observed,{reason:'insufficient_scope',status:403});
 assert.deepEqual(report.checks[4].observed,{reason:'invalid_arguments',status:400});assert.match(report.checks[4].remediation,/different reason/);
 assert.match(report.checks[5].remediation,/denied it \(permission_denied\)/);
 assert.match(report.checks[0].remediation,/authorize\(\) return false/);
 assert.match(report.checks[1].remediation,/caller\.tenant/);
 assert.match(report.checks[2].remediation,/abort signal/);
 assert.equal(calls,3);
 assert.equal(report.dashboard.url,null);
 // An inconclusive check alone is still not a pass.
 const only=await checkMCPRoute({env,plan:plan(resource,[{kind:'cancellation',caller:'owner',tool:'quick',afterMs:500}])});
 assert.deepEqual(only.checks.map(c=>c.status),['inconclusive']);assert.equal(only.passed,false);
});

test('check refuses unsafe or incomplete plans before contacting anything',async()=>{
 const base=plan('http://127.0.0.1:9/mcp',[{kind:'allowed',caller:'owner',tool:'read'}]);
 for(const [bad,pattern] of [
  [{...base,resource:'https://api.example/mcp'},/Unsupported endpoint/],
  [{...base,resource:'http://127.0.0.1:9/admin'},/Unsupported endpoint/],
  [{...base,checks:[{kind:'delete',caller:'owner',tool:'read'}]},/kind/],
  [{...base,checks:[{kind:'allowed',caller:'nobody',tool:'read'}]},/named caller/],
  [{...base,checks:[{kind:'cancellation',caller:'owner',tool:'wait'}]},/afterMs/],
  [{...base,propertyId:'not-a-uuid'},/UUID/],
 ]){
  const r=await checkMCPRoute({plan:bad,env});
  assert.equal(r.passed,false);assert.equal(r.checks[0].status,'unconfigured');assert.match(r.checks[0].remediation,pattern);assert.equal(r.route,null);
 }
 const missing=await checkMCPRoute({plan:base,env:{DOCTOR_TOKEN_A:'owned-a'}});
 assert.match(missing.checks[0].remediation,/Set DOCTOR_TOKEN_B/);
 // An unreachable route stops before any tool check runs.
 const down=await checkMCPRoute({plan:base,env,timeoutMs:200});
 assert.equal(down.route.passed,false);assert.deepEqual(down.checks.map(c=>c.status),['not_run']);assert.deepEqual(down.exercised.routes,[]);
});
