import {createQuotaOperationId,quotaHash} from './quota.mjs';
import {readJSON} from './transport.mjs';
const code=/^[a-z][a-z0-9_]{0,63}$/;
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e12;
const canonical=value=>JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])));
export function prepareWork(config,definition,name,policyVersion){
 const w={mode:'observe',failureMode:'open',timeoutMs:1000,...definition};
 const limits=Object.fromEntries(['caller','tenant','tool'].map(k=>[k,w.limits?.[k]??0]));
 if(!code.test(w.ruleId??'')||!integer(w.maxUnits)||w.maxUnits<1||!integer(w.windowSeconds)||w.windowSeconds<1||w.windowSeconds>86400||!integer(w.timeoutMs)||w.timeoutMs<1||w.timeoutMs>10000||!['observe','enforce'].includes(w.mode)||!['open','closed'].includes(w.failureMode)||!Object.values(limits).every(integer)||!Object.values(limits).some(n=>n>0)||(w.measure!==undefined&&typeof w.measure!=='function')||(w.operationId!==undefined&&typeof w.operationId!=='function'))throw Error('Invalid tool work policy');
 async function rpc(body,signal){
  const response=await fetch(new URL('/api/v1/sdk/ai-abuse/work',config.webdecoyUrl),{method:'POST',redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(w.timeoutMs)]),headers:{Authorization:`Bearer ${config.webdecoyKey}`,'X-WebDecoy-Property-ID':config.propertyId,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){await response.body?.cancel();const e=Error('Work unavailable');e.status=response.status;throw e;}
  const r=await readJSON(response,2048);
  if(r?.schema!==1||!['allowed','granted','replay','settled'].every(k=>typeof r[k]==='boolean')||!['reserved_units','charged_units','remaining_units','retry_after_seconds'].every(k=>integer(r[k]))||r.retry_after_seconds>86400||!code.test(r.reason??''))throw Error('Invalid work response');
  return r;
 }
 return async(ctx,signal)=>{
  let operationId=w.operationId?w.operationId(ctx):createQuotaOperationId();
  if(operationId&&typeof operationId.then==='function')Promise.resolve(operationId).catch(()=>{});
  if(typeof operationId!=='string'||! /^[1-9][0-9]{9}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId))throw Error('Invalid trusted work operation ID');
  const body={schema:1,operation:'reserve',operation_id:operationId,rule_id:w.ruleId,mode:w.mode,window_seconds:w.windowSeconds,limits,units:w.maxUnits,
   subject:quotaHash(config.subjectSecret,'webdecoy.work.caller.v1',ctx.caller.issuer,ctx.caller.tenant,ctx.caller.subject),tenant:quotaHash(config.subjectSecret,'webdecoy.work.tenant.v1',ctx.caller.issuer,ctx.caller.tenant),binding:quotaHash(config.subjectSecret,'webdecoy.work.arguments.v1',name,policyVersion,canonical(ctx.args))};
  const evidence={rule_id:w.ruleId,mode:w.mode,status:'unknown',reserved_units:w.maxUnits};
  const check={id:'tool_work',source:'shared',mode:w.mode,decision:'allow',reason:'work_allowed',durationMs:0};
  const began=performance.now();let grant,denial;
  try{
   grant=await rpc(body,signal);
   if(grant.replay){denial={reason:'work_replay',status:409};evidence.status='replay';}
   else if(!grant.granted){if(grant.reason!=='work_exceeded')throw Error('Invalid work denial');denial={reason:'work_exceeded',status:429,retryAfterSeconds:grant.retry_after_seconds};evidence.status='denied';}
   else {if(!['work_allowed','work_exceeded'].includes(grant.reason)||(!grant.allowed&&w.mode==='enforce')||grant.reserved_units!==w.maxUnits||grant.charged_units!==w.maxUnits)throw Error('Invalid work grant');evidence.status='reserved';}
   evidence.reserved_units=grant.reserved_units;evidence.charged_units=grant.charged_units;evidence.remaining_units=grant.remaining_units;
   check.reason=grant.reason;check.decision=grant.allowed&&!grant.replay?'allow':'deny';
  }catch(e){
   grant=undefined;
   signal?.throwIfAborted();check.decision='unavailable';check.reason='work_outcome_unknown';evidence.status='unavailable';
   if([400,403,409,410].includes(e.status)){denial={reason:e.status===409?'work_conflict':'work_operation_rejected',status:e.status};check.decision='deny';check.reason=denial.reason;}
   else if(w.mode==='enforce'&&w.failureMode==='closed')denial={reason:'work_outcome_unknown',status:503};
  }
  check.durationMs=performance.now()-began;
  return {check,denial,evidence,bound:Object.freeze({maxUnits:w.maxUnits}),async finish(result,completed){
   if(!grant?.granted||grant.replay)return;
   if(!completed){evidence.status='unknown';return;}
   try{
    const units=w.measure?w.measure(result,ctx):w.maxUnits;
    if(units&&typeof units.then==='function')Promise.resolve(units).catch(()=>{});
    if(!integer(units)||units>w.maxUnits)throw Error('Unconfirmed or excess work');
    const settled=await rpc({...body,operation:'settle',units});
    if(!settled.settled||settled.reason!=='work_settled'||settled.charged_units!==units)throw Error('Work settlement unavailable');
    evidence.status='settled';evidence.charged_units=units;
   }catch{evidence.status='unknown';return {id:'tool_work_settlement',source:'shared',mode:w.mode,decision:'unavailable',reason:'work_usage_unknown',durationMs:0};}
  }};
 };
}
