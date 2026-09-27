import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {createAIProtection} from '../fetch.mjs';
const request=()=>new Request('https://example.test/ai', {method:'POST',body:'secret prompt'});
test('local denial is centrally reported without scoring or leaking context; repeated report is idempotent',async t=>{
 const {state,options}=await fixture(t);
 const protect=createAIProtection({...options,reportToWebDecoy:true,
  rules:[{id:'plan',mode:'enforce',evaluate:()=>({allowed:false,reason:'paid_required'})}]});
 const d=await protect.check(request(),{userId:'private-user',prompt:'private-prompt'});
 await protect.report(d);await protect.report(d);
 assert.equal(state.calls,0);assert.equal(state.configCalls,0);assert.equal(state.reports.length,1);
 const {body,property}=state.reports[0];assert.equal(property,options.propertyId);
 assert.equal(body.decision,'deny');assert.equal(body.checks[0].source,'local');assert.equal(body.checks[1].decision,'skipped');
 for(const field of ['property_id','organization_id','subject','ip','context','prompt'])assert.equal(field in body,false);
 assert.equal(JSON.stringify(body).includes('private-'),false);
});
test('degraded report delivery failure never gates inference; cloud and custom sinks are independent',async t=>{
 const {state,options}=await fixture(t);state.status=503;state.reportStatus=503;
 const protect=createAIProtection({...options,reportToWebDecoy:true,onObservation:()=>{throw new Error('private sink error');}});
 assert.equal((await protect(request(),()=>new Response('ok'))).status,200);
 await protect.flush();assert.equal(state.reports.length,1);
 assert.equal(state.reports[0].body.degraded,true);assert.equal(state.reports[0].body.handler_attempted,true);
 assert.equal(state.reports[0].body.checks[0].reason,'detector_unavailable');
});
test('telemetry can be disabled without disabling local observations',async t=>{
 const {state,options}=await fixture(t);const protect=createAIProtection(options);
 await protect(request(),()=>new Response('ok'));await protect.flush();
 assert.equal(state.reports.length,0);assert.equal(state.events.length,1);
});
