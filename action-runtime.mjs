import {prepareWork} from './work.mjs';
import {prepareQuota,quotaHash} from './quota.mjs';
import {prepareConcurrency} from './concurrency.mjs';
import {validPropertyID} from './account.mjs';
import {readJSON} from './transport.mjs';
import {createReporter} from './reporting.mjs';

export function prepareActionRuntime(options, definitions) {
  const config=options.sharedRuntime;
  if(!config){if([...definitions.values()].some(d=>d.limits))throw Error('Action limits require sharedRuntime');return null;}
  const url=new URL(config.webdecoyUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
    (url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))||!validPropertyID(config.propertyId)||
    typeof config.webdecoyKey!=='string'||!config.webdecoyKey||/[^\x21-\x7e]/.test(config.webdecoyKey)||
    typeof config.subjectSecret!=='string'||!config.subjectSecret.isWellFormed()||Buffer.byteLength(config.subjectSecret)<32)throw Error('Invalid action runtime');
  if(config.reportCaller !== undefined && typeof config.reportCaller !== "boolean")throw Error("Invalid caller reporting option");
  if(config.callerPause !== undefined && typeof config.callerPause !== 'boolean')throw Error('Invalid caller pause option');
  if(config.toolPause !== undefined && typeof config.toolPause !== 'boolean')throw Error('Invalid tool pause option');
  if(config.toolPause && [...definitions.values()].some(d=>!d.toolSchema))throw Error('Tool pause requires toolSchema on every action');
  if(config.callerPause && !config.reportCaller)throw Error('Caller pause requires caller reporting');
  const pauseTimeout=config.callerPauseTimeoutMs??1000;
  if(!Number.isInteger(pauseTimeout)||pauseTimeout<1||pauseTimeout>10000)throw Error('Invalid caller pause timeout');
  const c={...config};const limits=new Map(),ruleIDs=new Set();
  const subject=(ctx,tenant)=>({accountId:tenant?quotaHash(c.subjectSecret,'webdecoy.actions.tenant.v1',ctx.caller.tenant):quotaHash(c.subjectSecret,'webdecoy.actions.caller.v1',ctx.caller.issuer,ctx.caller.tenant,ctx.caller.subject)});
  for(const [name,d] of definitions){
    const l=d.limits??{},gates=[];
    for(const [key,tenant]of [['callerQuota',false],['tenantQuota',true]])if(l[key]){
      const q=l[key];if(ruleIDs.has(q.ruleId))throw Error('Action limits require distinct rule IDs');ruleIDs.add(q.ruleId);
      const gate=prepareQuota({...c,accountQuota:{...q,idempotency:false,operationId:undefined,sessionLimit:0,subject:ctx=>subject(ctx,tenant)}});
      gates.push(async(ctx,signal)=>{const r=await gate(ctx,signal);if(r.check)r.check.id=tenant?'tenant_quota':'caller_quota';return r;});
    }
    const concurrencies=[];
    for(const [key,tenant] of [['concurrency',false],['tenantConcurrency',true]])if(l[key]){
      const option=l[key];if(ruleIDs.has(option.ruleId))throw Error('Action limits require distinct rule IDs');ruleIDs.add(option.ruleId);
      const gate=prepareConcurrency({...c,concurrency:{...option,subject:ctx=>subject(ctx,tenant)}});
      concurrencies.push(async(ctx,signal)=>{const r=await gate(ctx,signal);if(tenant)r.check.id='tenant_concurrency';return r;});
    }
    let work=null;
    if(l.work){if(ruleIDs.has(l.work.ruleId))throw Error('Action limits require distinct rule IDs');ruleIDs.add(l.work.ruleId);work=prepareWork(c,l.work,name,options.policyVersion);}
    limits.set(name,{gates,concurrencies,work});
  }
  const reporter=createReporter({reportingTimeoutMs:c.reportingTimeoutMs??1000,maxPendingReports:c.maxPendingReports??100,
    onObservation:async(event,{signal})=>{
      const checks=[{id:'action_boundary',source:'local',mode:'enforce',decision:event.decision,reason:event.reason,duration_ms:0},
        ...event.checks.map(check=>({id:check.id,source:check.source,mode:check.mode,decision:check.decision,reason:check.reason,duration_ms:check.durationMs,...(check.controlRevision?{control_revision:check.controlRevision}:{})}))];
      const payload={schema:2,request_id:event.eventId,timestamp:event.timestamp,decision:event.decision,reason:event.reason,
        degraded:event.checks.some(c=>c.decision==='unavailable'),checks,handler_attempted:event.attempted,
        action:event.decision==='deny'?'denied':event.outcome==='unknown'?'handler_error':'forwarded',
        tool_action:{action_id:event.actionId,name:event.action,policy_version:event.policyVersion,outcome:event.outcome,...(event.toolSchema?{tool_schema:{server_id:event.toolSchema.serverId,hash:event.toolSchema.hash,...(event.toolSchema.decoy?{decoy:event.toolSchema.decoy}:{}),...(event.toolSchema.effect?{effect:event.toolSchema.effect}:{}),...(event.toolSchema.permissions?{permissions:event.toolSchema.permissions}:{})}}:{}),...(event.caller?{caller:event.caller}:{}),...(event.work?{work:event.work}:{})}};
      const response=await fetch(new URL('/api/v1/sdk/ai-abuse/reports',url),{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${c.webdecoyKey}`,'X-WebDecoy-Property-ID':c.propertyId,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      await response.body?.cancel();if(!response.ok)throw Error('Action reporting unavailable');
    }});
  const checkCallerPause = c.callerPause ? async (caller,signal) => {
    signal.throwIfAborted();const started=performance.now();
    const check={id:'caller_pause',source:'shared',mode:'enforce',decision:'unavailable',reason:'caller_pause_unavailable',durationMs:0};
    let denial;
    try {
      const id=actionCallerEvidence(c,caller).id;
      const response=await fetch(new URL('/api/v1/sdk/ai-abuse/caller-pause',c.webdecoyUrl),{
        method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(pauseTimeout)]),
        headers:{Authorization:`Bearer ${c.webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':c.propertyId},body:JSON.stringify({schema:1,caller:id})
      });
      if(!response.ok){await response.body?.cancel();throw Error('Caller control unavailable');}
      const value=await readJSON(response,2048);
      if(value.schema!==1||value.property_id!==c.propertyId.toLowerCase()||value.caller!==id||typeof value.allowed!=='boolean'||value.reason!==(value.allowed?'caller_allowed':'caller_paused'))throw Error('Invalid caller control response');
      // Older runtimes omit revision evidence. Never invent it from receipt time.
      if(value.control_revision != null && (!validPropertyID(value.control_revision)||value.control_revision==='00000000-0000-0000-0000-000000000000'))throw Error('Invalid caller control revision');
      check.decision=value.allowed?'allow':'deny';check.reason=value.reason;
      if(value.control_revision != null)check.controlRevision=value.control_revision.toLowerCase();
      if(!value.allowed)denial={reason:'caller_paused',status:403};
    } catch { signal.throwIfAborted(); }
    check.durationMs=Math.max(0,performance.now()-started);return {check,denial};
  }:null;
  const checkToolPause = c.toolPause ? async (caller,name,toolSchema,signal) => {
    signal.throwIfAborted();const started=performance.now();
    const kinds=c.callerPause?['caller','tool']:['tool'];
    let checks=kinds.map(kind=>({id:kind+'_pause',source:'shared',mode:'enforce',decision:'unavailable',reason:kind+'_pause_unavailable',durationMs:0})),denial;
    try {
      const id=c.callerPause?actionCallerEvidence(c,caller).id:'';
      const response=await fetch(new URL('/api/v1/sdk/ai-abuse/caller-pause',c.webdecoyUrl),{
        method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(pauseTimeout)]),
        headers:{Authorization:`Bearer ${c.webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':c.propertyId},
        body:JSON.stringify({schema:2,caller:id,server_id:toolSchema.serverId,tool:name})
      });
      if(!response.ok){await response.body?.cancel();throw Error('Tool control unavailable');}
      const value=await readJSON(response,4096);
      if(value.schema!==2||value.property_id!==c.propertyId.toLowerCase()||value.caller!==id||value.server_id!==toolSchema.serverId||value.tool!==name||(!c.callerPause&&value.caller_control!==null))throw Error('Invalid tool control response');
      // Validate the entire combined response before accepting either decision.
      const checked=kinds.map(kind=>{
        const control=value[kind+'_control'];
        if(!control||typeof control.allowed!=='boolean'||control.reason!==kind+(control.allowed?'_allowed':'_paused')||
          (control.control_revision!=null&&!validPropertyID(control.control_revision)))throw Error('Invalid control evidence');
        return {id:kind+'_pause',source:'shared',mode:'enforce',decision:control.allowed?'allow':'deny',reason:control.reason,durationMs:0,
          ...(control.control_revision?{controlRevision:control.control_revision.toLowerCase()}:{})};
      });
      checks=checked;const denied=checks.find(check=>check.decision==='deny');
      if(denied)denial={reason:denied.reason,status:403};
    } catch {signal.throwIfAborted();}
    const durationMs=Math.max(0,performance.now()-started);
    return {checks:checks.map(check=>({...check,durationMs})),denial};
  }:null;
  return {limits,checkCallerPause,checkToolPause,callerEvidence:caller=>actionCallerEvidence(c,caller),report:event=>reporter.send(event),flush:()=>reporter.flush()};
}

export function actionCallerEvidence(config,caller) {
  return config.reportCaller?Object.freeze({schema:1,source:'application_auth',id:quotaHash(config.subjectSecret,'webdecoy.actions.evidence.caller.v1',config.propertyId.toLowerCase(),caller.issuer,caller.tenant,caller.subject)}):undefined;
}
