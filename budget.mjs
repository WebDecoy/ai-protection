import {randomUUID} from 'node:crypto';
import {quotaHash} from './quota.mjs';
const code=/^[a-z][a-z0-9_]{0,63}$/;
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const limitNames=['account_tokens','account_micros','tenant_tokens','tenant_micros','feature_tokens','feature_micros'];
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
export class BudgetDenied extends Error {
 constructor(reason,status,retryAfterSeconds=0){super(reason);this.name='BudgetDenied';this.status=status;this.retryAfterSeconds=retryAfterSeconds;}
}
// Explicit catalog only. Rates are integer micro-USD per million tokens; never floats.
export function budgetCost(price,inputTokens,outputTokens){
 if(!integer(inputTokens,10000000)||!integer(outputTokens,10000000)||!integer(price.inputMicrosPerMillion,1000000000)||!integer(price.outputMicrosPerMillion,1000000000))throw Error('Invalid budget usage or price');
 const total=BigInt(inputTokens)*BigInt(price.inputMicrosPerMillion)+BigInt(outputTokens)*BigInt(price.outputMicrosPerMillion);
 return Number((total+999999n)/1000000n);
}
export function ollamaBudgetUsage(final){
 if(final?.done!==true||typeof final.model!=='string'||!integer(final.prompt_eval_count,10000000)||!integer(final.eval_count,10000000))return null;
 return {provider:'ollama',model:final.model,inputTokens:final.prompt_eval_count,outputTokens:final.eval_count};
}
export function createAIBudget(options){
 const o={mode:'observe',failureMode:'open',timeoutMs:1000,maxRuntimeMs:300000,...options};
 const url=new URL(o.webdecoyUrl);
 if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!uuid.test(o.propertyId??'')||o.propertyId==='00000000-0000-0000-0000-000000000000'||typeof o.webdecoyKey!=='string'||!o.webdecoyKey.trim()||/[\r\n]/.test(o.webdecoyKey)||!code.test(o.ruleId??'')||typeof o.subject!=='function'||typeof o.subjectSecret!=='string'||!o.subjectSecret.isWellFormed()||Buffer.byteLength(o.subjectSecret)<32||!['observe','enforce'].includes(o.mode)||!['open','closed'].includes(o.failureMode)||!integer(o.windowSeconds,86400)||o.windowSeconds<1||!integer(o.timeoutMs,10000)||o.timeoutMs<1||!integer(o.maxRuntimeMs,900000)||o.maxRuntimeMs<1)throw Error('Invalid budget configuration');
 const limits=Object.fromEntries(limitNames.map(n=>[n,o.limits?.[n]??0]));
 if(!Object.values(limits).every(v=>integer(v,1e12))||!Object.values(limits).some(v=>v>0))throw Error('Invalid budget limits');
 const prices=new Map();
 for(const [id,p] of Object.entries(o.prices??{})){
  if(!code.test(id)||!code.test(p.provider??'')||typeof p.model!=='string'||!p.model.length||p.model.length>128||!p.model.isWellFormed())throw Error('Invalid budget price');
  budgetCost(p,0,0);prices.set(id,Object.freeze({...p}));
 }
 if(!prices.size||prices.size>64)throw Error('Explicit bounded price catalog required');
 async function rpc(body,signal){
  const res=await fetch(new URL('/api/v1/sdk/ai-abuse/budget',url),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(o.timeoutMs)]),headers:{Authorization:`Bearer ${o.webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':o.propertyId},body:JSON.stringify(body)});
  if(!res.ok){await res.body?.cancel();throw Error('Budget unavailable');}
  const reader=res.body.getReader();const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048)throw Error('Invalid budget response');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(r?.schema!==1||typeof r.allowed!=='boolean'||typeof r.granted!=='boolean'||typeof r.overrun!=='boolean'||!code.test(r.reason??'')||!integer(r.retry_after_seconds,86400)||(r.granted&&(!uuid.test(r.reservation_id??'')||r.reservation_id==='00000000-0000-0000-0000-000000000000')))throw Error('Invalid budget response');
  return r;
 }
 return Object.freeze({async run(context,call,work,callerSignal=new AbortController().signal){
  callerSignal.throwIfAborted();
  const price=prices.get(call.priceId);
  if(!price||!integer(call.maxInputTokens,10000000)||!integer(call.maxOutputTokens,10000000)||call.maxInputTokens+call.maxOutputTokens<1||typeof work!=='function')throw Error('Known price and conservative token bounds required');
  const bound=Object.freeze({provider:price.provider,model:price.model,maxInputTokens:call.maxInputTokens,maxOutputTokens:call.maxOutputTokens});
  const micros=budgetCost(price,bound.maxInputTokens,bound.maxOutputTokens);
  let body,grant;
  try{
   const s=o.subject(context);
   if(s&&typeof s.then==='function'){Promise.resolve(s).catch(()=>{});throw Error('Async subject');}
   for(const id of [s?.accountId,s?.organizationId])if(typeof id!=='string'||!id.isWellFormed()||!id.length||Buffer.byteLength(id)>256)throw Error('Invalid budget subject');
   body={schema:1,operation:'reserve',rule_id:o.ruleId,mode:o.mode,nonce:randomUUID(),subject:quotaHash(o.subjectSecret,'webdecoy.budget.v1',o.propertyId.toLowerCase(),o.ruleId,'account',s.accountId),tenant:quotaHash(o.subjectSecret,'webdecoy.budget.v1',o.propertyId.toLowerCase(),o.ruleId,'tenant',s.organizationId),window_seconds:o.windowSeconds,limits,tokens:bound.maxInputTokens+bound.maxOutputTokens,micros};
   grant=await rpc(body,callerSignal);
   if(grant.granted&&(!['budget_allowed','budget_exceeded'].includes(grant.reason)||(o.mode==='enforce'&&!grant.allowed)))throw Error('Invalid budget grant');
   if(!grant.granted&&!['budget_exceeded','budget_replay'].includes(grant.reason))throw Error('Invalid budget denial');
  }catch{
   callerSignal.throwIfAborted();
   if(o.mode==='enforce'&&o.failureMode==='closed')throw new BudgetDenied('budget_unavailable',503);
   grant=null;
  }
  if(grant&&!grant.granted)throw new BudgetDenied(grant.reason,429,Math.max(1,grant.retry_after_seconds));
  const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(o.maxRuntimeMs)]);
  signal.throwIfAborted();
  // Provider errors propagate; the conservative reservation stays charged.
  const result=await work({...bound,signal});
  if(!result||!result.finished||typeof result.finished.then!=='function')throw Error('Provider completion Promise required; reservation retained');
  const completion=Promise.resolve(result.finished);completion.catch(()=>{});
  const outcome=(reason,overrun=false)=>({reason,overrun,reserved:!!grant,wouldDeny:grant?.allowed===false});
  const accounting=(async()=>{
   let listener;
   try{
    if(signal.aborted)return outcome(grant?'budget_usage_unknown':'budget_unavailable');
    const stopped=new Promise((_,reject)=>{listener=()=>reject(Error('Provider stopped without confirmed usage'));if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});});
    const usage=await Promise.race([completion,stopped]);
    if(!grant)return outcome('budget_unavailable');
    if(!usage||usage.provider!==price.provider||usage.model!==price.model||!integer(usage.inputTokens,10000000)||!integer(usage.outputTokens,10000000))return outcome('budget_usage_unknown');
    const tokens=usage.inputTokens+usage.outputTokens,cost=budgetCost(price,usage.inputTokens,usage.outputTokens);
    const overrun=usage.inputTokens>bound.maxInputTokens||usage.outputTokens>bound.maxOutputTokens;
    const settle={...body,operation:'settle',reservation_id:grant.reservation_id,tokens,micros:cost};delete settle.nonce;
    try{
     const r=await rpc(settle,new AbortController().signal);
     return outcome(r.allowed&&r.reason==='budget_settled'?'budget_settled':'budget_settlement_unavailable',overrun||r.overrun);
    }catch{return outcome('budget_settlement_unavailable',overrun);}
   }catch{return outcome(grant?'budget_usage_unknown':'budget_unavailable');}
   finally{if(listener)signal.removeEventListener('abort',listener);}
  })();
  return {value:result.value,accounting};
 }});
}
