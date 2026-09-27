import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAdmission } from '../admission.mjs';

test('core admits a generic AI endpoint', async t => {
  let payload, decision = 'block', status = 200;
  const detector = createServer(async (req, res) => {
    if (req.url.endsWith('/ai-abuse/config')) {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({schema:1, mode:'enforce', property_id:'11111111-1111-4111-8111-111111111111', organization_id:'22222222-2222-4222-8222-222222222222', observe:true, enforce:true}));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    payload = JSON.parse(raw);
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify({decision_mode:'unified_v1', decision}));
  });
  await new Promise(resolve => detector.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { detector.close(resolve); detector.closeAllConnections(); }));
  const config = {propertyId:'11111111-1111-4111-8111-111111111111',webdecoyUrl:`http://127.0.0.1:${detector.address().port}`, webdecoyKey:'test-key',
    scopeId:'support-assistant', subjectSecret:'a-test-secret-with-more-than-32-characters'};
  const input = {ip:'192.0.2.1', method:'POST', path:'/ai/chat', headers:{'user-agent':'test-client'}};
  const enforce = createAdmission(config);
  let result = await enforce.check(input);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  assert.equal(payload.request_metadata.path, '/ai/chat');
  assert.equal(payload.decision_mode, 'unified_v1');
  const events = [];
  const observe = createAdmission({...config, protectionMode:'observe', onObservation:e => events.push(e)});
  result = await observe.check(input);
  assert.equal(result.allowed, true);
  assert.equal(result.observation.detector_decision, 'block');
  observe.record({...result.observation, upstream_status:200});
  assert.equal(events.length, 1);
  assert.equal(events[0].upstream_status, 200);
  decision = 'challenge';
  assert.equal((await enforce.check(input)).error, 'verification_required');
  status = 503;
  result = await enforce.check(input);
  assert.equal(result.allowed, true);
  assert.equal(result.observation.detector_decision, 'unavailable');
  const closed = createAdmission({...config, detectorFailureMode:'closed'});
  result = await closed.check(input);
  assert.equal(result.status, 503);
  assert.equal(result.observation.action, 'denied_unavailable');
});
