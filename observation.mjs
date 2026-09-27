import { createHmac } from 'node:crypto';

// Shadow-only fixed window per IP. Bounded state; saturation is reported as
// unknown, never as an allow or block. This is not a production rate limiter.
export function createBaseline({limit, windowMs, maxKeys = 10000}) {
  const buckets = new Map();
  let currentWindow;
  return (key, now = Date.now()) => {
    const window = Math.floor(now / windowMs);
    if (window !== currentWindow) { buckets.clear(); currentWindow = window; }
    if (!buckets.has(key) && buckets.size >= maxKeys) return 'unknown';
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    return count > limit ? 'block' : 'allow';
  };
}

export function observationSubject(secret, scopeId, ip) {
  // Rotate daily; never put raw IPs, prompts, user agents or session tokens in logs.
  return createHmac('sha256', secret).update(`observation:${scopeId}:${new Date().toISOString().slice(0, 10)}:${ip}`).digest('hex');
}

export function summarize(events, labels) {
  const byID = new Map();
  for (const label of labels) {
    if (!label.request_id || !['legitimate', 'abuse'].includes(label.label) || byID.has(label.request_id)) throw new Error('Invalid or duplicate independent label');
    byID.set(label.request_id, label.label);
  }
  const records = events.filter(e => e.event === 'webdecoy_admission');
  for (const e of records) {
    if (typeof e.request_id !== 'string' || !e.request_id ||
        !['allow','block','challenge','unavailable'].includes(e.detector_decision) ||
        !['allow','block','unknown'].includes(e.baseline_decision) ||
        !Number.isFinite(e.detector_ms) || e.detector_ms < 0) throw new Error('Invalid admission event');
  }
  const eventIDs = new Set(records.map(e => e.request_id));
  if (eventIDs.size !== records.length) throw new Error('Duplicate admission events');
  const matched = records.filter(e => byID.has(e.request_id));
  const policies = {};
  for (const policy of ['rate_limit', 'webdecoy', 'combined']) {
    const counts = {legitimate: 0, false_blocks: 0, abuse: 0, detected_abuse: 0, unknown: 0};
    for (const e of matched) {
      const rate = e.baseline_decision === 'unknown' ? null : e.baseline_decision === 'block';
      // Fail-open policy: unavailable detections do not block. Track them separately.
      const detected = ['block', 'challenge'].includes(e.detector_decision);
      const blocked = policy === 'rate_limit' ? rate : policy === 'webdecoy' ? detected : (detected || rate);
      if (blocked === null) { counts.unknown++; continue; }
      if (byID.get(e.request_id) === 'legitimate') { counts.legitimate++; if (blocked) counts.false_blocks++; }
      else { counts.abuse++; if (blocked) counts.detected_abuse++; }
    }
    policies[policy] = {...counts,
      false_block_rate: counts.legitimate ? counts.false_blocks / counts.legitimate : null,
      abuse_detection_rate: counts.abuse ? counts.detected_abuse / counts.abuse : null};
  }
  const latency = records.map(e => e.detector_ms).filter(Number.isFinite).sort((a,b) => a-b);
  const admissionLatency = records.map(e => e.detector_ms + (e.account_ms ?? 0)).sort((a,b) => a-b);
  return {requests: records.length, labeled_requests: matched.length,
    unmatched_labels: [...byID.keys()].filter(id => !eventIDs.has(id)).length,
    account_unavailable: records.filter(e => e.account_status && e.account_status !== 'verified').length,
    effective_modes: {observe: records.filter(e => e.mode === 'observe').length, enforce: records.filter(e => e.mode === 'enforce').length},
    unavailable_checks: records.filter(e => e.detector_decision === 'unavailable').length,
    admission_p95_ms: admissionLatency.length ? admissionLatency[Math.ceil(admissionLatency.length * .95) - 1] : null,
    detector_p95_ms: latency.length ? latency[Math.ceil(latency.length * .95) - 1] : null,
    baseline_unknown: records.filter(e => e.baseline_decision === 'unknown').length,
    additional_abuse_caught: matched.filter(e => byID.get(e.request_id) === 'abuse' && e.baseline_decision === 'allow' && ['block','challenge'].includes(e.detector_decision)).length,
    policies, savings: 'Not measured: requires actual model usage and pricing; blocked counts are not dollar savings.',
    limitations: ['Per-request metrics; labels must be independent of verdicts.', 'Shadow fixed-window per-IP baseline, one gateway process; not application-native controls.', 'No statistical confidence or production accuracy claim from a synthetic sample.']};
}
