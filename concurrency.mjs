import {randomUUID} from 'node:crypto';
import {quotaHash} from './quota.mjs';
const code=/^[a-z][a-z0-9_]{0,63}$/;
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function prepareConcurrency(options){
 if(options.concurrency===undefined)return null;
 const {webdecoyUrl,webdecoyKey,propertyId}=options;
 const q={mode:'observe',failureMode:'open',ttlSeconds:30,maxSeconds:300,timeoutMs:1000,subjectSecret:options.subjectSecret,...options.concurrency};
 if(!code.test(q.ruleId??'')||typeof q.subject!=='function'||typeof q.subjectSecret!=='string'||!q.subjectSecret.isWellFormed()||Buffer.byteLength(q.subjectSecret)<32||
 !['observe','enforce'].includes(q.mode)||!['open','closed'].includes(q.failureMode)||
 !Number.isInteger(q.accountLimit)||q.accountLimit<1||q.accountLimit>1000||!Number.isInteger(q.featureLimit)||q.featureLimit<q.accountLimit||q.featureLimit>10000||
 !Number.isInteger(q.ttlSeconds)||q.ttlSeconds<6||q.ttlSeconds>120||!Number.isInteger(q.maxSeconds)||q.maxSeconds<q.ttlSeconds||q.maxSeconds>900||
 !Number.isInteger(q.timeoutMs)||q.timeoutMs<1||q.timeoutMs>q.ttlSeconds*1000/6)throw Error('Invalid concurrency configuration');
 async function rpc(body,signal){
  const res=await fetch(new URL('/api/v1/sdk/ai-abuse/concurrency',webdecoyUrl),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(q.timeoutMs)]),headers:{Authorization:`Bearer ${webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':propertyId},body:JSON.stringify(body)});
  if(!res.ok){await res.body?.cancel();throw Error('Concurrency unavailable');}
  const reader=res.body.getReader();const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048)throw Error('Invalid concurrency response');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(r?.schema!==1||typeof r.allowed!=='boolean'||typeof r.granted!=='boolean'||!code.test(r.reason??'')||!Number.isInteger(r.retry_after_seconds)||r.retry_after_seconds<0||r.retry_after_seconds>q.maxSeconds||
   (r.granted&&(!uuid.test(r.lease_id)||r.lease_id==='00000000-0000-0000-0000-000000000000'||!Number.isInteger(r.valid_for_ms)||r.valid_for_ms<=0||r.valid_for_ms>q.ttlSeconds*1000)))throw Error('Invalid concurrency response');
  return r;
 }
 return async (context,callerSignal)=>{
  callerSignal.throwIfAborted();const began=performance.now();
  const check={id:'concurrency',source:'shared',mode:q.mode,decision:'unavailable',reason:'concurrency_unavailable',durationMs:0};
  let body,grant;
  try{
   const subject=q.subject(context);
   if(subject&&typeof subject.then==='function'){Promise.resolve(subject).catch(()=>{});throw Error('Async subject');}
   if(typeof subject?.accountId!=='string'||!subject.accountId.isWellFormed()||!subject.accountId.length||Buffer.byteLength(subject.accountId)>256)throw Error('Invalid concurrency subject');
   body={schema:1,operation:'acquire',rule_id:q.ruleId,mode:q.mode,nonce:randomUUID(),subject:quotaHash(q.subjectSecret,'webdecoy.account-quota.v1',propertyId.toLowerCase(),q.ruleId,'account',subject.accountId),account_limit:q.accountLimit,feature_limit:q.featureLimit,ttl_seconds:q.ttlSeconds,max_seconds:q.maxSeconds};
   grant=await rpc(body,callerSignal);
   if(grant.granted&&(!['concurrency_allowed','concurrency_exceeded'].includes(grant.reason)||(q.mode==='enforce'&&!grant.allowed)))throw Error('Invalid lease grant');
   if(!grant.granted&&!['concurrency_exceeded','concurrency_replay'].includes(grant.reason))throw Error('Invalid denial');
  }catch{
   callerSignal.throwIfAborted();check.durationMs=performance.now()-began;
   return {check,signal:callerSignal,finish:async()=>{},...(q.mode==='enforce'&&q.failureMode==='closed'?{denial:{reason:check.reason,status:503}}:{})};
  }
  callerSignal.throwIfAborted();check.durationMs=performance.now()-began;check.decision=grant.allowed?'allow':'deny';check.reason=grant.reason;
  if(!grant.granted)return {check,denial:{reason:grant.reason,status:429,retryAfterSeconds:Math.max(1,grant.retry_after_seconds)}};
  const controller=new AbortController();const signal=AbortSignal.any([callerSignal,controller.signal]);
  let deadline=began+grant.valid_for_ms,stopped=false,renewTimer,renewing=Promise.resolve(),finishing;
  const abort=()=>controller.abort(Error('Concurrency lease lost or expired'));
  const hardTimer=setTimeout(abort,Math.max(0,began+q.maxSeconds*1000-performance.now()));
  const owned={...body,lease_id:grant.lease_id};delete owned.nonce;
  function schedule(){
   if(stopped||signal.aborted)return;
   const remaining=deadline-performance.now();if(remaining<=q.timeoutMs){abort();return;}
   renewTimer=setTimeout(()=>{renewing=renew();},Math.min(q.ttlSeconds*1000/3,remaining/3));
  }
  async function renew(){
   const sent=performance.now();
   try{
    const safeWindow=Math.floor(deadline-performance.now()-100);if(safeWindow<=0)throw Error('Expired');
    const r=await rpc({...owned,operation:'renew'},AbortSignal.any([signal,AbortSignal.timeout(safeWindow)]));
    if(!r.granted||!r.allowed||r.reason!=='concurrency_renewed'||r.lease_id!==grant.lease_id)throw Error('Lost');
    deadline=sent+r.valid_for_ms;schedule();
   }catch{abort();}
  }
  signal.addEventListener('abort',()=>{clearTimeout(renewTimer);clearTimeout(hardTimer)},{once:true});
  schedule();
  return {check,signal,finish(confirmed){
   if(finishing)return finishing;
   finishing=(async()=>{
    const release=confirmed&&!signal.aborted;stopped=true;clearTimeout(renewTimer);clearTimeout(hardTimer);
    controller.abort(Error('Protected work ended'));await renewing;
    if(release){const r=await rpc({...owned,operation:'release'},new AbortController().signal);if(!r.allowed||r.reason!=='concurrency_released')throw Error('Concurrency release unavailable');}
   })();return finishing;
  }};
 };
}
