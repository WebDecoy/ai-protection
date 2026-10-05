import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {wireMCPRoute} from '../scripts/wire-mcp-route.mjs';
const template="// private surrounding application configuration\n// WEBDECOY:MCP_IMPORT\nexport function route(req: any, res: any) {\n// WEBDECOY:MCP_ROUTE\n  res.end('other');\n}\n";
async function fixture(t){const project=await mkdtemp(join(tmpdir(),'wd-wire-'));t.after(()=>rm(project,{recursive:true,force:true}));await writeFile(join(project,'package.json'),'{"type":"module"}');await writeFile(join(project,'route.ts'),template);await writeFile(join(project,'handler.ts'),"export function protectedMCPHandler(req: any, res: any) { res.end('protected'); }\n");return {project,routeFile:'route.ts',handlerFile:'handler.ts'};}
test('plan, repeat apply and rollback preserve unrelated route edits',async t=>{
 const f=await fixture(t),run=command=>wireMCPRoute({...f,command}),file=join(f.project,'route.ts');
 const plan=await run('plan');assert.equal(plan.status,'proposed');assert.ok(!JSON.stringify(plan).includes('private surrounding'));assert.equal(await readFile(file,'utf8'),template);
 assert.equal((await run('apply')).status,'wired');assert.equal((await run('apply')).status,'unchanged');
 await writeFile(file,(await readFile(file,'utf8')).replace("res.end('other')","res.end('custom')"));
 assert.equal((await run('rollback')).status,'unwired');assert.equal(await readFile(file,'utf8'),template.replace("res.end('other')","res.end('custom')"));assert.equal((await run('rollback')).status,'unchanged');
});
test('edits to generated blocks and duplicated markers cannot be overwritten',async t=>{
 const f=await fixture(t),file=join(f.project,'route.ts');await wireMCPRoute({...f,command:'apply'});const edited=(await readFile(file,'utf8')).replace("=== '/mcp'","=== '/private'");await writeFile(file,edited);
 for(const command of ['apply','rollback'])await assert.rejects(wireMCPRoute({...f,command}));assert.equal(await readFile(file,'utf8'),edited);
 await writeFile(file,template+'// WEBDECOY:MCP_ROUTE\n');await assert.rejects(wireMCPRoute({...f,command:'apply'}));
});
test('outside and symlink paths are rejected',async t=>{
 const f=await fixture(t);await symlink(join(f.project,'route.ts'),join(f.project,'link.ts'));
 for(const routeFile of ['../outside.ts','link.ts'])await assert.rejects(wireMCPRoute({...f,routeFile,command:'apply'}));
});
test('compiled route dispatches only selected paths and preserves other requests',async t=>{
 const f=await fixture(t);await wireMCPRoute({...f,command:'apply'});
 const root=fileURLToPath(new URL('..',import.meta.url));execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--strict','--module','nodenext','--target','es2022',join(f.project,'route.ts')],{stdio:'pipe'});
 const {route}=await import(pathToFileURL(join(f.project,'route.js')));
 for(const [url,want] of [['/mcp','protected'],['/mcp?q=1','protected'],['/.well-known/oauth-protected-resource/mcp','protected'],['/other','other'],['/mcp-admin','other']]){let result;route({url},{end:value=>{result=value;}});assert.equal(result,want);}
});
