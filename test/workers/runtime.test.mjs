import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare, Response} from 'miniflare';

const bundle = await build({entryPoints:[new URL('./fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'], alias:process.env.WEBDECOY_WORKERS_PACKAGE_DIR ? {'@webdecoy/ai-protection/workers':process.env.WEBDECOY_WORKERS_PACKAGE_DIR+'/workers.mjs'} : {}});
async function fixture(t, overrides={}) {
  const state={decision:'allow',detectorStatus:200,reports:[],configCalls:0,detectCalls:0,quotaCalls:[],quotaAllowed:true,redirects:0,outboundErrors:[],...overrides};
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],
    outboundService:async request=>{
      try {
      assert.equal(new URL(request.url).origin,'https://control.test');
      assert.equal(request.headers.get('authorization'),'Bearer fixture');
      const path=new URL(request.url).pathname;
      if(state.redirectPath && path.endsWith('/'+state.redirectPath)) {state.redirects++;return new Response(null,{status:302,headers:{Location:'https://credentials-leak.test/'}});}
      if(path.endsWith('/config')) {
        state.configCalls++;
        await new Promise(resolve=>setTimeout(resolve,15));
        return Response.json({schema:1,mode:'enforce',property_id:'11111111-1111-4111-8111-111111111111',organization_id:'22222222-2222-4222-8222-222222222222',observe:true,enforce:true});
      }
      if(path.endsWith('/reports')) {
        // Deliberately complete after the handler returns; requires ctx.waitUntil.
        const event=await request.json();
        await new Promise(resolve=>setTimeout(resolve,30));state.reports.push(event);
        return Response.json({}, {status:202});
      }
      if(path.endsWith('/quota')) {
        const body=await request.json();state.quotaCalls.push(body);
        if(state.retryQuota && state.quotaCalls.length===1)return new Response('unavailable',{status:503});
        return Response.json({schema:2,operation_id:body.operation_id,allowed:state.quotaAllowed,reason:state.quotaAllowed?'account_quota_allowed':'account_quota_exceeded',remaining:0,reset_at:Math.floor(Date.now()/1000)+60,retry_after_seconds:state.quotaAllowed?0:60});
      }
      assert.equal(path,'/api/v1/sdk/detect');state.detectCalls++;
      return Response.json({decision_mode:'unified_v1',decision:state.decision},{status:state.detectorStatus});
      } catch(error) {state.outboundErrors.push(error.message); throw error;}
    }
  });
  t.after(async()=>{await mf.dispose();assert.deepEqual(state.outboundErrors,[], 'unexpected service calls or fixture failures');});
  async function reports(count) {
    const deadline=Date.now()+3000;
    while(state.reports.length<count&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(state.reports.length,count,'background reports completed');
  }
  return {mf,state,reports};
}
test('Workers allows original response and completes asynchronous reporting',async t=>{
  const {mf,state,reports}=await fixture(t);
  const r=await mf.dispatchFetch('https://owned.test/allow');assert.equal(r.status,200);assert.equal(r.headers.get('x-fixture'),'original');assert.equal(await r.text(),'model fixture');
  await reports(1);assert.equal(state.reports[0].handler_attempted,true);assert.equal(state.configCalls,1);assert.equal(state.detectCalls,1);
});
test('Workers local and cloud denials prevent model invocation',async t=>{
  const {mf,state,reports}=await fixture(t,{decision:'block'});
  const local=await mf.dispatchFetch('https://owned.test/local');assert.equal(local.status,403);await local.text();assert.equal(state.configCalls,0);assert.equal(state.detectCalls,0);
  const remote=await mf.dispatchFetch('https://owned.test/block');assert.equal(remote.status,403);await remote.text();await reports(2);
  assert.ok(state.reports.every(r=>r.handler_attempted===false));
});
test('Workers detector outage is degraded fail-open',async t=>{
  const {mf,state,reports}=await fixture(t,{detectorStatus:503});
  const r=await mf.dispatchFetch('https://owned.test/outage');assert.equal(r.status,200);await r.text();await reports(1);assert.equal(state.reports[0].degraded,true);
});
test('Workers overlapping requests have independent config and lifecycle',async t=>{
  const {mf,state,reports}=await fixture(t);
  await Promise.all(Array.from({length:6},async()=>{
    const r=await mf.dispatchFetch('https://owned.test/allow');
    assert.equal(r.status,200);assert.equal(await r.text(),'model fixture');
  }));
  await reports(6);assert.equal(state.configCalls,6);assert.equal(new Set(state.reports.map(r=>r.request_id)).size,6);
});
test('Workers hard quota denial and idempotent recovery use the shared service',async t=>{
  const {mf,state,reports}=await fixture(t,{quotaAllowed:false,retryQuota:true});
  const r=await mf.dispatchFetch('https://owned.test/quota');assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');await r.text();await reports(1);
  assert.equal(state.quotaCalls.length,2);assert.deepEqual(state.quotaCalls[0],state.quotaCalls[1]);assert.equal(state.detectCalls,0);assert.equal(state.reports[0].handler_attempted,false);
  assert.ok(!JSON.stringify(state.quotaCalls).includes('authenticated-account'));
});
test('Workers forwards streaming bodies and rejects pre-cancelled admission',async t=>{
  const {mf,state,reports}=await fixture(t);
  const r=await mf.dispatchFetch('https://owned.test/stream');assert.equal(r.headers.get('x-fixture'),'original');assert.equal(await r.text(),'first\nlast\n');await reports(1);
  const cancelled=await mf.dispatchFetch('https://owned.test/cancelled');assert.equal(cancelled.status,499);assert.equal(await cancelled.text(),'AbortError');assert.equal(state.detectCalls,1);
});

test('Workers refuses redirects without forwarding credentials',async t=>{
  for(const redirectPath of ['config','detect','quota','reports']) {
    await t.test(redirectPath,async t=>{
      const {mf,state}=await fixture(t,{redirectPath});
      const r=await mf.dispatchFetch('https://owned.test/'+(redirectPath==='quota'?'quota':'allow'));
      assert.equal(r.status,redirectPath==='quota'?503:200);await r.text();
      // Wait for the request-owned reporter to attempt delivery as well.
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok(state.redirects>0);
      if(redirectPath==='config'||redirectPath==='quota')assert.equal(state.detectCalls,0);
    });
  }
});

test('Workers shared quota allowance invokes the model once',async t=>{
  const {mf,state,reports}=await fixture(t);
  const r=await mf.dispatchFetch('https://owned.test/quota');assert.equal(r.status,200);
  assert.equal(await r.text(),'model fixture');await reports(1);
  assert.equal(state.quotaCalls.length,1);assert.equal(state.detectCalls,1);
  assert.equal(state.reports[0].handler_attempted,true);
});
