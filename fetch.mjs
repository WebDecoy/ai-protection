import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createAdmission } from './admission.mjs';
import { prepareRules, evaluateRules } from './rules.mjs';
import { createReporter } from './reporting.mjs';
import { createTelemetry } from './telemetry.mjs';

// Node runtime only. Authentication and input validation belong before this API.
export function createAIProtection(options) {
  if (typeof options.resolveClientIP !== 'function') throw new Error('resolveClientIP is required');
  const admission = createAdmission(options);
  const rules = prepareRules(options.rules);
  const telemetry = createTelemetry(options);
  const localSink = options.onObservation ?? (event => console.log(JSON.stringify(event)));
  const reporter = createReporter({...options, onObservation:async (event, runtime) => {
    // Start telemetry before handing a separate event copy to the customer's sink.
    // A sink cannot mutate the wire payload or prevent the other destination running.
    const deliveries = await Promise.allSettled([
      telemetry(event, runtime), Promise.resolve().then(() => localSink(structuredClone(event), runtime))
    ]);
    if (deliveries.some(result => result.status === 'rejected')) throw new Error('Report delivery failed');
  }});
  // Private bookkeeping: no context, Request, body or raw rule errors retained.
  const observations = new WeakMap();
  function finish(observation, checks, denial) {
    const decision = Object.freeze({id:observation.request_id,
      conclusion:denial ? 'deny' : 'allow', reason:denial?.reason ?? 'allowed',
      ...(denial ? {status:denial.status} : {}),
      degraded:checks.some(c => c.decision === 'unavailable' || c.reason === 'client_ip_unavailable'),
      checks:Object.freeze(checks.map(c => Object.freeze(c)))});
    observations.set(decision, {...observation, handler_attempted:false, decision:decision.conclusion,
      reason:decision.reason === 'allowed' && observation.reason ? observation.reason : decision.reason,
      degraded:decision.degraded, checks:decision.checks});
    return decision;
  }
  async function check(request, context = {}) {
    request.signal.throwIfAborted();
    // Only caller-supplied SERVER context enters rules. Never infer identity or
    // account plan from body/header values, and never serialize context remotely.
    const local = evaluateRules(rules, context, request.signal);
    const skipped = reason => ({event:'webdecoy_admission_skipped', schema:1,
      request_id:randomUUID(), property_id:options.propertyId, timestamp:new Date().toISOString(),
      reason, action:local.denial ? 'denied' : 'forwarded', upstream_attempted:false});
    if (local.denial) {
      return finish(skipped('local_denial'), [...local.checks,
        {id:'webdecoy',source:'remote',mode:options.protectionMode ?? 'enforce',decision:'skipped',reason:'local_denial',durationMs:0}], local.denial);
    }
    const ip = await options.resolveClientIP(request);
    request.signal.throwIfAborted();
    if (typeof ip !== 'string' || !isIP(ip)) {
      return finish(skipped('client_ip_unavailable'), [...local.checks,
        {id:'webdecoy',source:'remote',mode:options.protectionMode ?? 'enforce',decision:'skipped',reason:'client_ip_unavailable',durationMs:0}]);
    }
    const result = await admission.check({ip, method:request.method,
      path:new URL(request.url).pathname,
      headers:Object.fromEntries(request.headers), signal:request.signal});
    const observation = result.observation;
    const remote = {id:'webdecoy',source:'remote',mode:observation.mode,
      decision:observation.detector_decision === 'block' ? 'deny' : observation.detector_decision,
      reason:observation.account_status !== 'verified' ? observation.account_status
        : observation.detector_decision === 'unavailable' ? 'detector_unavailable' : `detector_${observation.detector_decision}`,
      durationMs:observation.account_ms + observation.detector_ms};
    const decision = finish(observation, [...local.checks, remote],
      result.allowed ? undefined : {reason:result.error,status:result.status});
    if (request.signal.aborted) {
      // No usable decision on cancellation; still emit a best-effort outcome.
      void report(decision, {cancelled:true});
      request.signal.throwIfAborted();
    }
    return decision;
  }
  function report(decision, outcome = {}) {
    const event = observations.get(decision);
    if (!event) return Promise.resolve(); // Once per decision; foreign decisions cannot inject events.
    observations.delete(decision);
    // Explicit fields only. Never spread application objects into telemetry.
    event.handler_attempted = outcome.handlerAttempted === true;
    if (Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599) event.handler_status = outcome.status;
    if (outcome.cancelled === true) event.action = 'cancelled';
    else if (outcome.handlerError === true) event.action = 'handler_error';
    return reporter.send(event);
  }
  async function protect(request, handler, context = {}) {
    const decision = await check(request, context);
    const outcome = {handlerAttempted:false};
    try {
      request.signal.throwIfAborted();
      if (decision.conclusion === 'deny') return Response.json({error:decision.reason, request_id:decision.id}, {
        status:decision.status, headers:{'Cache-Control':'no-store', 'X-WebDecoy-Request-ID':decision.id}
      });
      outcome.handlerAttempted = true;
      const response = await handler();
      outcome.status = response.status;
      return response; // Original response/body: no stream reader or rewriting.
    } catch (error) {
      outcome.cancelled = request.signal.aborted;
      outcome.handlerError = !outcome.cancelled;
      throw error;
    } finally { void report(decision, outcome); }
  }
  return Object.assign(protect, {check, report, flush:reporter.flush});
}
