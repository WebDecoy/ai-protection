import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAccountBinding } from '../account.mjs';

test('account grants expire, failed refresh cannot retain paid access, mismatch cannot bind another property', async t => {
  const property = '11111111-1111-4111-8111-111111111111';
  let now = 0, count = 0, status = 200;
  const value = {schema:1, mode:'enforce', property_id:property, organization_id:'22222222-2222-4222-8222-222222222222', observe:true, enforce:true};
  const server = createServer((req, res) => {
    count++;
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const read = createAccountBinding({webdecoyUrl:`http://127.0.0.1:${server.address().port}`, webdecoyKey:'test', propertyId:property, detectorTimeoutMs:1000, now:() => now});
  const signal = new AbortController().signal;
  const results = await Promise.all([read(signal),read(signal)]);
  assert.ok(results.every(r => r.enforce)); assert.equal(count,1);
  value.enforce=false;
  now=60001;
  assert.equal((await read(signal)).enforce,false); assert.equal(count,2);
  value.enforce=true; now+=60001;
  assert.equal((await read(signal)).enforce,true);
  status=503;now+=60001;
  assert.deepEqual(await read(signal),{status:'unavailable',enforce:false});
  status=200; value.property_id='33333333-3333-4333-8333-333333333333'; now+=5001;
  assert.deepEqual(await read(signal),{status:'property_mismatch',enforce:false});
  value.property_id=property;value.schema=2;now+=5001;
  assert.deepEqual(await read(signal),{status:'unavailable',enforce:false});
});
