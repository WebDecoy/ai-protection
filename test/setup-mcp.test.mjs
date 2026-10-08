import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setupMCP} from '../scripts/setup-mcp.mjs';
async function fixture(t,overrides={}){
 const project=await mkdtemp(join(tmpdir(),'wd-setup-'));t.after(()=>rm(project,{recursive:true,force:true}));
 await writeFile(join(project,'package.json'),JSON.stringify({type:'module',dependencies:{'@webdecoy/ai-protection':'0.1.0-beta.0','@modelcontextprotocol/sdk':'1.31.0'},scripts:{prepare:'DO NOT RUN'},...overrides}));
 // An installer must never import or execute this selected module.
 await writeFile(join(project,'options.ts'),"throw new Error('project code executed');");
 return {project,optionsFile:'options.ts'};
}
test('reviewable plan, repeat apply and rollback preserve the selected source',async t=>{
 const f=await fixture(t),run=command=>setupMCP({...f,command});
 const plan=await run('plan');assert.equal(plan.status,'proposed');assert.match(plan.diff,/mcpOptions satisfies ProtectedMCPOptions/);assert.equal(plan.coverage,'not_verified');
 await assert.rejects(readFile(join(f.project,'webdecoy-mcp.ts')),{code:'ENOENT'});
 assert.equal((await run('apply')).status,'created');assert.equal((await run('apply')).status,'unchanged');assert.equal((await run('plan')).status,'already_generated');
 assert.equal((await run('rollback')).status,'removed');assert.equal((await run('rollback')).status,'absent');assert.match(await readFile(join(f.project,'options.ts'),'utf8'),/project code executed/);
});
test('edited handler is never overwritten or removed',async t=>{
 const f=await fixture(t);await setupMCP({...f,command:'apply'});const path=join(f.project,'webdecoy-mcp.ts');await writeFile(path,'customer edits');
 assert.equal((await setupMCP({...f,command:'plan'})).status,'conflict');
 for(const command of ['apply','rollback'])await assert.rejects(setupMCP({...f,command}));
 assert.equal(await readFile(path,'utf8'),'customer edits');
});
test('unsupported project metadata is diagnosed without executing scripts',async t=>{
 const f=await fixture(t,{type:'commonjs',dependencies:{}});const plan=await setupMCP({...f,command:'plan'});assert.ok(plan.checks.some(c=>c.status==='unsupported'));
 await assert.rejects(setupMCP({...f,command:'apply'}),/Resolve package checks/);
});
test('paths outside the project and symlink targets cannot be changed',async t=>{
 const f=await fixture(t);
 for(const optionsFile of ['../outside.ts','/tmp/outside.ts','options.ts;echo'])await assert.rejects(setupMCP({...f,optionsFile,command:'apply'}));
 await symlink(join(f.project,'options.ts'),join(f.project,'linked.ts'));
 await assert.rejects(setupMCP({...f,optionsFile:'linked.ts',command:'apply'}),/Symlink/);
 await symlink(join(f.project,'options.ts'),join(f.project,'webdecoy-mcp.ts'));
 await assert.rejects(setupMCP({...f,command:'apply'}),/regular file/);
});

test('generated handler compiles against the public SDK contract',async t=>{
 const f=await fixture(t),root=fileURLToPath(new URL('..',import.meta.url));
 await mkdir(join(f.project,'node_modules','@webdecoy'),{recursive:true});
 await symlink(root,join(f.project,'node_modules','@webdecoy','ai-protection'),'dir');
 await symlink(join(root,'node_modules','@types'),join(f.project,'node_modules','@types'),'dir');
 await writeFile(join(f.project,'options.ts'),"import type {ProtectedMCPOptions} from '@webdecoy/ai-protection/mcp';\nexport declare const mcpOptions: ProtectedMCPOptions;\n");
 await setupMCP({...f,command:'apply'});
 execFileSync(process.execPath,[join(root,'node_modules','typescript','bin','tsc'),'--strict','--noEmit','--module','nodenext','--target','es2022',join(f.project,'webdecoy-mcp.ts')],{stdio:'pipe'});
});
