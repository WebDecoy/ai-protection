import { createAccountBinding, validPropertyID } from './account.mjs';
import { randomUUID } from 'node:crypto';
import { createBaseline, observationSubject } from './observation.mjs';

// Adapters authenticate/validate their request and resolve a trustworthy client IP
// before calling check. No model calls, sessions, routes or response rewriting here.
export function createAdmission(options) {
  const c = {protectionMode: 'enforce', detectorFailureMode: 'open', detectorTimeoutMs: 1000,
    baselineLimit: 10, baselineWindowMs: 60000,
    onObservation: event => console.log(JSON.stringify(event)), ...options};
  if (!['observe', 'enforce'].includes(c.protectionMode) || !['open', 'closed'].includes(c.detectorFailureMode)) throw new Error('Invalid admission mode');
  for (const key of ['detectorTimeoutMs', 'baselineLimit', 'baselineWindowMs']) {
    if (!Number.isSafeInteger(c[key]) || c[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  const url = new URL(c.webdecoyUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid detector origin');
  if (!c.webdecoyKey || /[\r\n]/.test(c.webdecoyKey) || !c.scopeId || typeof c.subjectSecret !== 'string' || c.subjectSecret.length < 32 || typeof c.onObservation !== 'function') throw new Error('Invalid admission configuration');
  if (!validPropertyID(c.propertyId)) throw new Error('An existing WebDecoy propertyId is required');
  const accountBinding = createAccountBinding(c);
  const baseline = createBaseline({limit: c.baselineLimit, windowMs: c.baselineWindowMs});
  return {
    async check({ip, method, path, headers, signal = new AbortController().signal}) {
      const requestId = randomUUID();
      const accountStarted = performance.now();
      const account = await accountBinding(signal);
      const accountMs = Math.round((performance.now() - accountStarted) * 100) / 100;
      const mode = account.status === 'verified' && account.enforce && account.mode === 'enforce' ? c.protectionMode : 'observe';
      const observation = {event: 'webdecoy_admission', schema: 1, request_id: requestId,
        timestamp: new Date().toISOString(), mode, requested_mode: c.protectionMode, property_id: c.propertyId,
        account_status: account.status, account_ms: accountMs,
        subject: observationSubject(c.subjectSecret, c.scopeId, ip),
        baseline_limit: c.baselineLimit, baseline_window_ms: c.baselineWindowMs,
        baseline_decision: baseline(ip), detector_decision: 'unavailable',
        detector_ms: 0, action: 'unavailable', upstream_attempted: false};
      if (account.status !== 'verified') {
        observation.action = 'forwarded';
        return {observation, allowed:true};
      }
      const checkStarted = performance.now();
      let verdict;
      try {
        const response = await fetch(new URL('/api/v1/sdk/detect', c.webdecoyUrl), {
          method: 'POST', redirect: 'error',
          headers: {'Authorization': `Bearer ${c.webdecoyKey}`, 'Content-Type': 'application/json'},
          signal: AbortSignal.any([signal, AbortSignal.timeout(c.detectorTimeoutMs)]),
          body: JSON.stringify({
            decision_mode: 'unified_v1',
            ai_admission: {request_id:requestId, mode},
            request_metadata: {method, path, ip, user_agent: headers['user-agent'] ?? '', timestamp: Date.now()},
            cs: {hn: Object.keys(headers), al: headers['accept-language'] ?? '', ae: headers['accept-encoding'] ?? ''},
            local_analysis: {needs_verification: true}
          })
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('detector_http'); }
        verdict = await response.json();
        // Older servers ignore unknown request fields; require an explicit
        // acknowledgement so a legacy metadata-only allow cannot look protected.
        if (verdict?.decision_mode !== 'unified_v1') throw new Error('unsupported_decision_mode');
        if (!['allow', 'block', 'challenge'].includes(verdict?.decision)) throw new Error('invalid_verdict');
        observation.detector_decision = verdict.decision;
      } catch {
        if (mode === 'enforce' && c.detectorFailureMode === 'closed') {
          observation.action = 'denied_unavailable';
          return {observation, allowed: false, status: 503, error: 'protection_unavailable'};
        }
        // A failed check is not an abuse verdict. Preserve availability without
        // relaxing origin, session, input, capacity or upstream authentication checks.
        console.warn(JSON.stringify({event: 'webdecoy_check_unavailable', action: 'allowed_without_verdict'}));
        verdict = {decision: 'allow'};
      } finally { observation.detector_ms = Math.round((performance.now() - checkStarted) * 100) / 100; }
      // A challenge is never silently accepted; interactive clearance is a later integration.
      observation.action = mode === 'enforce' && verdict.decision !== 'allow' ? 'denied' : 'forwarded';
      if (observation.action === 'denied') return {observation, allowed: false, status: 403, error: verdict.decision === 'challenge' ? 'verification_required' : 'request_denied'};
      return {observation, allowed: true};
    },
    record(observation) {
      try { c.onObservation(observation); } catch { console.warn('Observation sink failed'); }
    }
  };
}
