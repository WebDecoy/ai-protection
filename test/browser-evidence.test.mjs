import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBrowserEvidence} from '../browser.mjs';
import {prepareBrowserOrigin,browserEvidenceInput,browserEvidenceCheck} from '../browser-evidence.mjs';
const property='11111111-1111-4111-8111-111111111111';
test('only selected evidence cookie crosses the transport boundary',()=>{
 const origin=prepareBrowserOrigin('https://owned.test');
 const r=browserEvidenceInput(origin,property,{cookie:`session=private; __Host-wd_runtime_${property}=payload.signature; auth=secret`});
 assert.deepEqual(r,{origin,token:'payload.signature'});assert.ok(!JSON.stringify(r).includes('private'));
 assert.equal(browserEvidenceInput(origin,property,{cookie:`__Host-wd_runtime_${property}=a.b; __Host-wd_runtime_${property}=c.d`}).token,'');
 assert.equal(browserEvidenceInput(origin,property,{cookie:`__Host-wd_runtime_${property}=${'a'.repeat(4097)}`}).token,'');
 for(const bad of ['http://owned.test','https://owned.test/path','https://user:pass@owned.test','https://owned.test/'])assert.throws(()=>prepareBrowserOrigin(bad));
 assert.equal(browserEvidenceCheck('invalid','enforce').decision,'unavailable');assert.equal(browserEvidenceCheck('block','enforce').decision,'deny');
});
test('browser preparation is optional, bounded and cannot block an AI request on failure',async()=>{
 assert.deepEqual(await prepareBrowserEvidence(),{available:false});
 globalThis.window={dispatchEvent:e=>e.detail.done(true)};globalThis.CustomEvent=class{constructor(name,options){this.detail=options.detail}};
 try{assert.deepEqual(await prepareBrowserEvidence(),{available:true});window.dispatchEvent=()=>{};assert.deepEqual(await prepareBrowserEvidence({timeoutMs:5}),{available:false});window.dispatchEvent=()=>{throw Error('blocked')};assert.deepEqual(await prepareBrowserEvidence(),{available:false})}finally{delete globalThis.window;delete globalThis.CustomEvent}
});
