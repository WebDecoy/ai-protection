import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBaseline, summarize } from '../observation.mjs';

test('shadow limiter counts by subject, resets windows and marks capacity unknown', () => {
  const check = createBaseline({limit:2, windowMs:1000, maxKeys:2});
  assert.equal(check('shared', 0), 'allow');
  assert.equal(check('shared', 1), 'allow');
  assert.equal(check('shared', 2), 'block');
  assert.equal(check('other', 3), 'allow');
  assert.equal(check('overflow', 4), 'unknown');
  assert.equal(check('shared', 1000), 'allow');
  assert.equal(check('overflow', 1000), 'allow');
});

test('comparison uses independent labels, counts challenges and exposes unavailable coverage', () => {
  const e = (request_id, detector_decision, baseline_decision) => ({event:'webdecoy_admission', request_id, detector_decision, baseline_decision, detector_ms:10});
  const events = [e('a','block','allow'),e('b','challenge','allow'),e('c','unavailable','block'),e('d','allow','unknown')];
  const labels = [{request_id:'a',label:'abuse'},{request_id:'b',label:'legitimate'},{request_id:'c',label:'abuse'},{request_id:'d',label:'legitimate'}];
  const result = summarize(events, labels);
  assert.equal(result.policies.webdecoy.false_block_rate, .5);
  assert.equal(result.policies.webdecoy.abuse_detection_rate, .5);
  assert.equal(result.policies.combined.abuse_detection_rate, 1);
  assert.equal(result.policies.rate_limit.unknown, 1);
  assert.equal(result.additional_abuse_caught, 1);
  assert.equal(result.unavailable_checks, 1);
  assert.equal(result.detector_p95_ms, 10);
  assert.equal(summarize(events, []).policies.webdecoy.false_block_rate, null);
  assert.throws(() => summarize(events, [...labels, labels[0]]), /duplicate/);
});
