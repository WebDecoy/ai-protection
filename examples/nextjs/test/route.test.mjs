import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fixture} from '../../../test/fixture.mjs';

test('real Next.js + AI SDK route: authentication, validation, allow stream, deny, outage',async t=>{
  const {state,options}=await fixture(t);
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','0'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,
      WEBDECOY_URL:options.webdecoyUrl,WEBDECOY_KEY:options.webdecoyKey,WEBDECOY_PROPERTY_ID:options.propertyId,
      WEBDECOY_SUBJECT_SECRET:options.subjectSecret,WEBDECOY_MODE:'enforce',WEBDECOY_LOCAL_FIXTURE:'1',EXAMPLE_TOKEN:'local-test-token',EXAMPLE_PLAN:'free'}
  });
  let output=''; child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  t.after(async()=>{child.kill();if(child.exitCode===null) await new Promise(r=>child.once('exit',r));});
  let origin;
  for(let i=0;i<200;i++){
    origin=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if(origin && output.includes('Ready'))break;
    if(child.exitCode!==null)throw new Error(output);
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(origin && output.includes('Ready'),output);
  const send=(body,auth=true)=>fetch(`${origin}/api/chat`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer local-test-token'}:{})},body:JSON.stringify(body)});
  assert.equal((await send({prompt:'hello'},false)).status,401);assert.equal(state.calls,0);
  assert.equal((await send({prompt:9})).status,400);assert.equal(state.calls,0);
  // Body-supplied plan cannot override authenticated/server plan context.
  const denied=await send({prompt:'x'.repeat(4001),plan:'paid'});
  assert.equal(denied.status,403);assert.equal((await denied.json()).error,'plan_input_limit');assert.equal(state.calls,0);
  let response=await send({prompt:'private-input'});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const stream=await response.text();assert.match(stream,/Local model response/);assert.match(stream,/\[DONE\]/);
  assert.equal(JSON.stringify(state.payload).includes('private-input'),false);
  state.decision='block';response=await send({prompt:'hello'});assert.equal(response.status,403);assert.equal((await response.json()).error,'request_denied');
  state.status=503;response=await send({prompt:'hello'});assert.equal(response.status,200);assert.match(await response.text(),/Local model response/);
  for(let i=0;i<100 && !output.includes('webdecoy_admission_skipped');i++)await new Promise(r=>setTimeout(r,10));
  assert.match(output,/webdecoy_admission_skipped/); // after() lifecycle receives local-only reports too.
});
