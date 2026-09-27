import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root = new URL('..', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'webdecoy-ai-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack','--dry-run=false','--json','--ignore-scripts','--pack-destination',dir], {cwd:root,encoding:'utf8'}));
  const expected = ['ARCHITECTURE.md','LICENSE','NEXTJS.md','README.md','account.mjs','admission.mjs','fetch.d.mts','fetch.mjs','observation.mjs','package.json','rules.mjs','reporting.mjs','telemetry.mjs'];
  assert.deepEqual(pack.files.map(f=>f.path).sort(),expected.sort(), 'Unexpected package contents');
  const consumer=join(dir,'consumer');mkdirSync(consumer);
  writeFileSync(join(consumer,'package.json'), JSON.stringify({private:true,type:'module'}));
  execFileSync('npm',['install','--dry-run=false','--ignore-scripts','--no-audit','--no-fund',join(dir,pack.filename)],{cwd:consumer,stdio:'pipe'});
  execFileSync(process.execPath,['--input-type=module','-e',
    "import {createAIProtection as root} from '@webdecoy/ai-protection'; import {createAIProtection as subpath} from '@webdecoy/ai-protection/fetch'; if(typeof root!=='function'||root!==subpath)throw Error('Invalid exports');"],{cwd:consumer,stdio:'pipe'});
  console.log(`Verified ${pack.filename}: exact file allowlist and isolated consumer imports.`);
} catch (error) {
  if (error.stdout?.length) process.stderr.write(error.stdout);
  if (error.stderr?.length) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(dir,{recursive:true,force:true});}
