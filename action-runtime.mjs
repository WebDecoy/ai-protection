import {prepareWork} from './work.mjs';
import {prepareQuota,quotaHash} from './quota.mjs';
import {prepareConcurrency} from './concurrency.mjs';
import {validPropertyID} from './account.mjs';
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
        ...event.checks.map(check=>({id:check.id,source:check.source,mode:check.mode,decision:check.decision,reason:check.reason,duration_ms:check.durationMs}))];
      const payload={schema:2,request_id:event.eventId,timestamp:event.timestamp,decision:event.decision,reason:event.reason,
        degraded:event.checks.some(c=>c.decision==='unavailable'),checks,handler_attempted:event.attempted,
        action:event.decision==='deny'?'denied':event.outcome==='unknown'?'handler_error':'forwarded',
        tool_action:{action_id:event.actionId,name:event.action,policy_version:event.policyVersion,outcome:event.outcome,...(event.toolSchema?{tool_schema:{server_id:event.toolSchema.serverId,hash:event.toolSchema.hash,...(event.toolSchema.effect?{effect:event.toolSchema.effect}:{})}}:{}),...(event.caller?{caller:event.caller}:{}),...(event.work?{work:event.work}:{})}};
      const response=await fetch(new URL('/api/v1/sdk/ai-abuse/reports',url),{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${c.webdecoyKey}`,'X-WebDecoy-Property-ID':c.propertyId,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      await response.body?.cancel();if(!response.ok)throw Error('Action reporting unavailable');
    }});
  return {limits,callerEvidence:caller=>c.reportCaller?Object.freeze({schema:1,source:'application_auth',id:quotaHash(c.subjectSecret,'webdecoy.actions.evidence.caller.v1',c.propertyId.toLowerCase(),caller.issuer,caller.tenant,caller.subject)}):undefined,report:event=>reporter.send(event),flush:()=>reporter.flush()};
}
