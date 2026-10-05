import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root = new URL('..', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'webdecoy-ai-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack','--dry-run=false','--json','--ignore-scripts','--pack-destination',dir], {cwd:root,encoding:'utf8'}));
  const expected = ['tool-effects.mjs','WORK.md','work.mjs','mcp.mjs','mcp.d.mts','MCP.md','action-runtime.mjs','actions.mjs','actions.d.mts','ARCHITECTURE.md','NOTICE','LICENSE','NEXTJS.md','README.md','account.mjs','admission.mjs','fetch.d.mts','fetch.mjs','observation.mjs','package.json','rules.mjs','reporting.mjs','telemetry.mjs','quota.mjs','concurrency.mjs','budget.mjs','browser.mjs','browser.d.mts','browser-evidence.mjs','usage.mjs','transport.mjs','workers.mjs','workers.d.mts','WORKERS.md'];
  assert.deepEqual(pack.files.map(f=>f.path).sort(),expected.sort(), 'Unexpected package contents');
  const manifest=JSON.parse(execFileSync('tar',['-xOf',join(dir,pack.filename),'package/package.json'],{encoding:'utf8'}));
  assert.notEqual(manifest.private,true,'Release must be publishable');
  assert.equal(manifest.license,'Apache-2.0','Release license must match owner approval');
  assert.deepEqual(manifest.dependencies??{}, {}, 'Review any new runtime dependencies');
  assert.deepEqual(manifest.optionalDependencies??{}, {}, 'Review any optional dependencies');
  assert.deepEqual(manifest.peerDependencies, {'@modelcontextprotocol/sdk':'1.31.0'});
  assert.deepEqual(manifest.peerDependenciesMeta, {'@modelcontextprotocol/sdk':{optional:true}});
  assert.equal(manifest.scripts?.install,undefined,'No install-time execution');
  assert.equal(manifest.scripts?.postinstall,undefined,'No install-time execution');
  console.log(`Artifact integrity: ${pack.integrity}`);
  const consumer=join(dir,'consumer');mkdirSync(consumer);
  writeFileSync(join(consumer,'package.json'), JSON.stringify({private:true,type:'module'}));
  execFileSync('npm',['install','--dry-run=false','--ignore-scripts','--no-audit','--no-fund',join(dir,pack.filename)],{cwd:consumer,stdio:'pipe'});
  assert.equal(existsSync(join(consumer,'node_modules/@modelcontextprotocol/sdk')),false,'Core consumers must not install the MCP peer automatically');
  execFileSync(process.execPath,['--input-type=module','-e',
    "import {createWorkerAIProtection} from '@webdecoy/ai-protection/workers'; if(typeof createWorkerAIProtection!=='function')throw Error('Missing Workers export'); import {createActionProtection} from '@webdecoy/ai-protection/actions'; if(typeof createActionProtection!=='function')throw Error('Missing actions export'); import {prepareBrowserEvidence} from '@webdecoy/ai-protection/browser'; if(typeof prepareBrowserEvidence!=='function')throw Error('Missing browser export'); import {createAIProtection as root} from '@webdecoy/ai-protection'; import {createAIProtection as subpath} from '@webdecoy/ai-protection/fetch'; if(typeof root!=='function'||root!==subpath)throw Error('Invalid exports');"],{cwd:consumer,stdio:'pipe'});
  console.log(`Verified ${pack.filename}: exact file allowlist and isolated consumer imports.`);
  process.stdout.write(execFileSync(process.execPath, ['--test',new URL('../test/workers/runtime.test.mjs',import.meta.url).pathname], {cwd:consumer,env:{...process.env,WEBDECOY_WORKERS_PACKAGE_DIR:join(consumer,'node_modules/@webdecoy/ai-protection')},encoding:'utf8'}));
  console.log('Verified packed Workers adapter in workerd.');
  // Test the tarball's transport using a real MCP client, without repository imports.
  execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund','@modelcontextprotocol/sdk@1.31.0','jose@6.2.12','@types/node@22.19.15'],{cwd:consumer,stdio:'pipe'});
  writeFileSync(join(consumer,'authenticate.mjs'),readFileSync(new URL('../examples/auth0/authenticate.mjs',import.meta.url)));
  const mcpTests=readFileSync(new URL('../examples/mcp/test/server.test.mjs',import.meta.url),'utf8')
    .replace("'../dist/server.js'","'@webdecoy/ai-protection/mcp'")
    .replace("'../../auth0/authenticate.mjs'","'./authenticate.mjs'");
  writeFileSync(join(consumer,'mcp.test.mjs'),mcpTests);
  process.stdout.write(execFileSync(process.execPath,['--test','mcp.test.mjs'],{cwd:consumer,encoding:'utf8'}));
  writeFileSync(join(consumer,'mcp-types.mts'),readFileSync(new URL('../test/mcp-types.mts',import.meta.url)));
  execFileSync(process.execPath,[new URL('../node_modules/typescript/bin/tsc',import.meta.url).pathname,'--strict','--noEmit','--module','nodenext','--target','es2022','mcp-types.mts'],{cwd:consumer,stdio:'pipe'});
  console.log('Verified packed MCP transport, real-client behavior, and public TypeScript declarations.');
  process.stdout.write(execFileSync(process.execPath,['--test',new URL('../test/mcp-install-flow.test.mjs',import.meta.url).pathname],{cwd:consumer,env:{...process.env,WEBDECOY_INSTALL_SDK_ROOT:join(consumer,'node_modules/@webdecoy/ai-protection')},encoding:'utf8'}));
  console.log('Verified clean setup, route wiring, dispatch, cancellation and rollback against the packed SDK.');
} catch (error) {
  if (error.stdout?.length) process.stderr.write(error.stdout);
  if (error.stderr?.length) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(dir,{recursive:true,force:true});}
