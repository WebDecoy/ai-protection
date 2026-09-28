import {browserEvidenceCheck} from './browser-evidence.mjs';
export {createAIBudget, BudgetDenied, budgetCost, ollamaBudgetUsage} from './budget.mjs';
import { prepareConcurrency } from './concurrency.mjs';
import { prepareQuota } from './quota.mjs';
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
  const quota=prepareQuota(options);
  const concurrency=prepareConcurrency(options);
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
      ...(denial ? {status:denial.status,...(denial.retryAfterSeconds ? {retryAfterSeconds:denial.retryAfterSeconds} : {})} : {}),
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
    const shared=await quota(context,request.signal);
    if(shared.check)local.checks.push(shared.check);
    if(shared.denial) return finish({...skipped('quota_denial'),action:shared.denial.status===503?'denied_unavailable':'denied'}, [...local.checks,
      {id:'webdecoy',source:'remote',mode:options.protectionMode ?? 'enforce',decision:'skipped',reason:'quota_denial',durationMs:0}],shared.denial);
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
    const browserChecks=options.browserEvidenceOrigin?[browserEvidenceCheck(observation.browser_evidence,observation.mode)]:[];
    const decision = finish(observation, [...local.checks, remote,...browserChecks],
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
    if(concurrency)throw Error("Use protect.concurrent with an explicit completion promise when concurrency is configured");
    const decision = await check(request, context);
    const outcome = {handlerAttempted:false};
    try {
      request.signal.throwIfAborted();
      if (decision.conclusion === 'deny') return Response.json({error:decision.reason, request_id:decision.id}, {
        status:decision.status, headers:{'Cache-Control':'no-store', 'X-WebDecoy-Request-ID':decision.id,...(decision.retryAfterSeconds?{'Retry-After':String(decision.retryAfterSeconds)}:{})}
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
  async function untilStopped(value,signal){
    let stop;
    const aborted=new Promise((_,reject)=>{stop=()=>reject(signal.reason??Error('Protected work cancelled'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
    try{return await Promise.race([Promise.resolve(value),aborted]);}finally{signal.removeEventListener('abort',stop);}
  }
  async function concurrent(request,handler,context={}) {
    if(!concurrency)throw Error('Concurrency configuration required');
    const admitted=await check(request,context);
    if(admitted.conclusion==='deny'){
      void report(admitted,{handlerAttempted:false});
      return Response.json({error:admitted.reason,request_id:admitted.id},{status:admitted.status,headers:{'Cache-Control':'no-store',...(admitted.retryAfterSeconds?{'Retry-After':String(admitted.retryAfterSeconds)}:{})}});
    }
    const lease=await concurrency(context,request.signal);
    const event=observations.get(admitted);observations.delete(admitted);
    const decision=finish({...event,action:lease.denial?'denied':'forwarded'},[...admitted.checks,lease.check],lease.denial);
    if(lease.denial){void report(decision,{handlerAttempted:false});return Response.json({error:decision.reason,request_id:decision.id},{status:decision.status,headers:{'Cache-Control':'no-store',...(decision.retryAfterSeconds?{'Retry-After':String(decision.retryAfterSeconds)}:{})}});}
    let attempted=false;
    try {
      lease.signal.throwIfAborted();attempted=true;
      const result=await untilStopped(handler({signal:lease.signal}),lease.signal);
      if(!(result?.response instanceof Response)||!result.finished||typeof result.finished.then!=='function')throw Error('Return {response, finished}: finished must track provider/stream completion');
      const completion=(async()=>{
        let completed=false;
        try{await untilStopped(result.finished,lease.signal);completed=!lease.signal.aborted;}catch{}
        try{await lease.finish(completed);}catch{completed=false;}
        await report(decision,{handlerAttempted:true,status:result.response.status,cancelled:request.signal.aborted,handlerError:!completed});
      })();
      completion.catch(()=>{});
      if(options.waitUntil)options.waitUntil(completion);
      return result.response; // Unchanged stream; app supplies the actual lifecycle.
    }catch(error){
      await lease.finish(false).catch(()=>{});
      void report(decision,{handlerAttempted:attempted,cancelled:request.signal.aborted,handlerError:true});throw error;
    }
  }
  return Object.assign(protect, {check, report, concurrent, flush:reporter.flush});
}
