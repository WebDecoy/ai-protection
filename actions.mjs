import {randomUUID} from 'node:crypto';
import {abortable} from './transport.mjs';
import {prepareActionRuntime} from './action-runtime.mjs';

import { snapshotToolEffect, snapshotToolPermissions } from './tool-effects.mjs';
const token = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const bounded = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

export class ActionDenied extends Error {
  constructor(reason, status, actionId) {
    super(reason); this.name = 'ActionDenied'; this.reason = reason; this.status = status; this.actionId = actionId;
  }
}

// Authentication is owned by the application's server integration. This validates
// its contract; it does not verify a bearer token, signer, or model-supplied claim.
function callerSnapshot(value) {
  if (!value || value.schema !== 1 || !bounded(value.subject) || !bounded(value.tenant) ||
      !bounded(value.issuer) || !bounded(value.authenticationMethod) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() ||
      !Array.isArray(value.scopes) || value.scopes.length > 64 || value.scopes.some(s => !bounded(s)) ||
      (value.clientId !== undefined && !bounded(value.clientId))) throw Error('Invalid authenticated caller');
  return freeze({schema:1, subject:value.subject, tenant:value.tenant, issuer:value.issuer,
    authenticationMethod:value.authenticationMethod, expiresAt:value.expiresAt,
    scopes:[...new Set(value.scopes)], ...(value.clientId === undefined ? {} : {clientId:value.clientId})});
}

// No accessors, class instances, cycles, non-finite numbers, or unbounded trees.
// Copy before any await so a caller cannot swap arguments while policy runs.
function inputSnapshot(input) {
  let nodes = 0;
  const seen = new Set();
  function copy(value, depth) {
    if (++nodes > 2048 || depth > 12) throw Error('Input too complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > 16384) throw Error('Input too large'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value) ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error('Invalid JSON input');
    if (Array.isArray(value) && value.length > 2048) throw Error('Input array too large');
    const keys = Object.keys(value);
    if (keys.length > 2048) throw Error('Input too complex');
    seen.add(value);
    const out = Array.isArray(value) ? [] : Object.create(null);
    for (const key of keys) {
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) throw Error('Invalid array key');
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !('value' in d) || key.length > 512 || ['__proto__','constructor','prototype'].includes(key)) throw Error('Invalid input key');
      out[key] = copy(d.value, depth + 1);
    }
    seen.delete(value);
    return Object.freeze(out);
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw Error('Input too large');
  return result;
}

/** Protected dispatch with local permissions and optional shared controls. Never retries execution. */
export function createActionProtection(options) {
  if (!options || typeof options.authenticate !== 'function' || (typeof options.policyVersion !== 'string' || !token.test(options.policyVersion))) throw Error('Invalid action configuration');
  const authenticate = options.authenticate, policyVersion = options.policyVersion, sink = options.onEvent;
  if (sink !== undefined && typeof sink !== 'function') throw Error('Invalid event sink');
  const admissionTimeoutMs = options.admissionTimeoutMs ?? 1000;
  if (!Number.isInteger(admissionTimeoutMs) || admissionTimeoutMs < 1 || admissionTimeoutMs > 10000) throw Error('Invalid admission timeout');
  const actions = new Map();
  for (const [name, definition] of Object.entries(options.actions ?? {})) {
    if (!token.test(name) || !definition || !Array.isArray(definition.requiredScopes) || definition.requiredScopes.length > 64 ||
        definition.requiredScopes.some(s => !bounded(s)) ||
        ['validate','authorize','execute'].some(k => typeof definition[k] !== 'function') ||
        (definition.policy !== undefined && typeof definition.policy !== 'function')) throw Error('Invalid action definition');
    const t = definition.toolSchema;
    if (t !== undefined && (!t || typeof t.serverId !== 'string' || !token.test(t.serverId) ||
        (t.decoy!==undefined && !['advertised','unadvertised'].includes(t.decoy)) || typeof t.hash !== 'string' || !/^[a-f0-9]{64}$/.test(t.hash))) throw Error('Invalid tool schema evidence');
    const toolSchema = t === undefined ? undefined : Object.freeze({serverId:t.serverId,hash:t.hash,...(t.decoy?{decoy:t.decoy}:{}),...(t.effect===undefined?{}:{effect:snapshotToolEffect(t.effect)}),...(t.permissions===undefined?{}:{permissions:snapshotToolPermissions(t.permissions)})});
    actions.set(name, Object.freeze({...definition,toolSchema,requiredScopes:Object.freeze([...definition.requiredScopes])}));
  }
  if (!actions.size || actions.size > 128) throw Error('Expected 1–128 actions');
  const runtime=prepareActionRuntime(options,actions);
  let pendingEvents = 0;
  return Object.freeze({flush:async()=>{await runtime?.flush();},async run(name, input, authenticationContext, {signal} = {}) {
    const actionId = randomUUID();
    // Unknown caller-controlled action strings are never placed in evidence.
    const action = actions.get(name), eventAction = action ? name : 'unregistered';
    let attempted = false,completed=false,lease,work,callerEvidence;
    const leases=[];
    const checks=[];
    const deadline = new AbortController();
    const admissionSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new DOMException('Action admission timed out','TimeoutError')), admissionTimeoutMs);
    const evaluate = fn => abortable(Promise.resolve().then(() => { admissionSignal.throwIfAborted(); return fn(); }), admissionSignal);
    function emit(decision, reason, outcome) {

      const event = Object.freeze({schema:1, eventId:randomUUID(), timestamp:new Date().toISOString(), actionId, action:eventAction, policyVersion,
        ...(callerEvidence?{caller:callerEvidence}:{}),...(action?.toolSchema?{toolSchema:action.toolSchema}:{}),evaluation:'local', decision, reason, attempted, outcome,...(work?{work:Object.freeze({...work.evidence})}:{}),checks:Object.freeze(checks.map(c=>Object.freeze({...c})))});
      if(runtime)void runtime.report(event);
      if(!sink||pendingEvents>=100)return;
      pendingEvents++;
      Promise.resolve().then(() => sink(event)).catch(() => {}).finally(() => { pendingEvents--; });
    }
    function deny(reason, status, retryAfterSeconds) { emit('deny', reason, 'not_attempted'); const e=new ActionDenied(reason,status,actionId);if(retryAfterSeconds)e.retryAfterSeconds=retryAfterSeconds;throw e; }
    function cancelled() { (attempted ? signal : admissionSignal)?.throwIfAborted(); }
    try {
      cancelled();
      if (!action) deny('action_not_registered',403);
      let args;
      try { args = inputSnapshot(input); } catch { deny('invalid_arguments',400); }
      let caller;
      try { caller = callerSnapshot(await evaluate(() => authenticate(authenticationContext, {signal:admissionSignal}))); }
      catch { cancelled(); deny('authentication_required',401); }
      callerEvidence=runtime?.callerEvidence(caller);
      cancelled();
      if (action.requiredScopes.some(scope => !caller.scopes.includes(scope))) deny('missing_scope',403);
      const context = Object.freeze({caller, args, signal:admissionSignal});
      let valid;
      try { valid = await evaluate(() => action.validate(args)); } catch { cancelled(); deny('invalid_arguments',400); }
      cancelled();
      if (valid !== true) deny('invalid_arguments',400);
      let authorized;
      try { authorized = await evaluate(() => action.authorize(context)); } catch { cancelled(); deny('authorization_unavailable',503); }
      cancelled();
      if (authorized !== true) deny('permission_denied',403);
      if (action.policy) {
        let permitted;
        try { permitted = await evaluate(() => action.policy(context)); } catch { cancelled(); deny('policy_unavailable',503); }
        cancelled();
        if (permitted !== true) deny('policy_denied',403);
      }
      // Shared limits run only after application permission checks. Their own
      // RPC deadlines are separate from local admission and detector availability.
      clearTimeout(timer);
      if(runtime?.checkToolPause){
        const r=await runtime.checkToolPause(caller,name,action.toolSchema,admissionSignal);checks.push(...r.checks);
        if(r.denial)deny(r.denial.reason,r.denial.status);
      }else if(runtime?.checkCallerPause){
        const r=await runtime.checkCallerPause(caller,admissionSignal);checks.push(r.check);
        if(r.denial)deny(r.denial.reason,r.denial.status);
      }
      const controls=runtime?.limits.get(name);
      for(const gate of controls?.gates??[]){
        const r=await gate(context,admissionSignal);checks.push(r.check);
        if(r.denial)deny(r.denial.reason,r.denial.status,r.denial.retryAfterSeconds);
      }
      for(const gate of controls?.concurrencies??[]){
        lease=await gate(context,lease?.signal??admissionSignal);leases.push(lease);checks.push(lease.check);
        if(lease.denial)deny(lease.denial.reason,lease.denial.status,lease.denial.retryAfterSeconds);
        lease.signal.throwIfAborted();
      }
      if(controls?.work){
        work=await controls.work(context,lease?.signal??admissionSignal);checks.push(work.check);
        if(work.denial)deny(work.denial.reason,work.denial.status,work.denial.retryAfterSeconds);
      }
      // Authentication may expire while ownership/policy checks are running.
      if (caller.expiresAt <= Date.now()) deny('authentication_expired',401);
      cancelled();
      clearTimeout(timer);
      attempted = true;
      emit('allow','authorized','attempted');
      const execution=Object.freeze({...context,...(work?{work:work.bound}:{}),signal:lease?.signal??context.signal});
      const result = await action.execute(execution);
      execution.signal.throwIfAborted();
      // Resolution is application completion, not proof of an external side effect.
      cancelled();
      completed=true;
      if(work){const check=await work.finish(result,true);if(check)checks.push(check);}
      for(const lease of [...leases].reverse())if(!lease.denial){
        const began=performance.now();
        try{await lease.finish(true);}catch{checks.push({id:lease.check.id==='tenant_concurrency'?'tenant_concurrency_release':'concurrency_release',source:'shared',mode:lease.check.mode,decision:'unavailable',reason:'concurrency_release_unavailable',durationMs:performance.now()-began});}
      }
      emit('allow','authorized','completed');
      return result;
    } catch (error) {
      if (!attempted && deadline.signal.aborted && !signal?.aborted) deny('admission_timeout',503);
      if(work&&!completed)await work.finish(undefined,false);
      if (attempted) emit('allow',signal?.aborted ? 'execution_cancelled' : 'execution_failed','unknown');
      else if (!(error instanceof ActionDenied)) emit('deny','admission_cancelled','not_attempted');
      throw error;
    } finally {
      clearTimeout(timer);
      // Only confirmed completion (or no callback) releases; uncertain work holds.
      for(const lease of [...leases].reverse())if(!lease.denial)await lease.finish(!attempted||completed).catch(()=>{});
    }
  }});
}
