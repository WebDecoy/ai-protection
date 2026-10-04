import {createHmac,randomUUID} from 'node:crypto';
export function createQuotaOperationId() { return `${Math.floor(Date.now()/1000)}.${randomUUID()}`; }
const operationPattern=/^[1-9][0-9]{9}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const code = /^[a-z][a-z0-9_]{0,63}$/;
export function quotaHash(secret, ...parts) {
  const h = createHmac('sha256', secret);
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    h.update(length); h.update(bytes);
  }
  return h.digest('hex');
}
export function prepareQuota(options) {
  if (options.accountQuota === undefined) return async () => ({});
  const {webdecoyUrl,webdecoyKey,propertyId}=options;
  const q = {mode:'observe',failureMode:'open',timeoutMs:1000,sessionLimit:0,idempotency:false,
    subjectSecret:options.subjectSecret,...options.accountQuota};
  if (typeof q.idempotency!=='boolean' || (q.operationId!==undefined&&(!q.idempotency||typeof q.operationId!=='function')) || !code.test(q.ruleId ?? '') || typeof q.subject !== 'function' ||
      typeof q.subjectSecret !== 'string' || !q.subjectSecret.isWellFormed() || Buffer.byteLength(q.subjectSecret)<32 ||
      !['observe','enforce'].includes(q.mode) || !['open','closed'].includes(q.failureMode) ||
      !Number.isInteger(q.limit) || q.limit<1 || q.limit>1000000 ||
      !Number.isInteger(q.windowSeconds) || q.windowSeconds<1 || q.windowSeconds>86400 ||
      !Number.isInteger(q.sessionLimit) || q.sessionLimit<0 || q.sessionLimit>q.limit ||
      !Number.isInteger(q.timeoutMs) || q.timeoutMs<1 || q.timeoutMs>10000) throw Error('Invalid account quota configuration');
  return async (context, signal) => {
    signal.throwIfAborted(); const started=performance.now();
    const check={id:'account_quota',source:'shared',mode:q.mode,decision:'unavailable',reason:'account_quota_unavailable',durationMs:0};
    let denial;
    try {
      const subject=q.subject(context);
      if (subject && typeof subject.then==='function') {Promise.resolve(subject).catch(()=>{});throw Error('Async subject');}
      const valid=value=>typeof value==='string'&&value.length>0&&value.isWellFormed()&&Buffer.byteLength(value)<=256;
      if (!valid(subject?.accountId) || (subject.sessionId!==undefined&&subject.sessionId!==''&&!valid(subject.sessionId)) || (q.sessionLimit>0&&!valid(subject.sessionId))) throw Error('Invalid subject');
      const parts=['webdecoy.account-quota.v1',propertyId.toLowerCase(),q.ruleId];
      let operationId;
      if(q.idempotency){
        operationId=q.operationId?q.operationId(context):createQuotaOperationId();
        if(operationId&&typeof operationId.then==='function'){Promise.resolve(operationId).catch(()=>{});throw Error('Async operation ID');}
        if(typeof operationId!=='string'||!operationPattern.test(operationId))throw Error('Invalid operation ID');
        check.operationId=operationId;
      }
      const payload={schema:q.idempotency?2:1,...(operationId?{operation_id:operationId}:{}),rule_id:q.ruleId,subject:quotaHash(q.subjectSecret,...parts,'account',subject.accountId),
        limit:q.limit,window_seconds:q.windowSeconds,session_limit:q.sessionLimit};
      if(q.sessionLimit>0)payload.session=quotaHash(q.subjectSecret,...parts,'session',subject.accountId,subject.sessionId);
      let result;
      for(let attempt=0;attempt<(q.idempotency?2:1);attempt++){
       signal.throwIfAborted();
       try {
      const response=await fetch(new URL('/api/v1/sdk/ai-abuse/quota',webdecoyUrl),{
        method:'POST',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(q.timeoutMs)]),
        headers:{Authorization:`Bearer ${webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':propertyId},body:JSON.stringify(payload)
      });
      if(!response.ok){await response.body?.cancel();const error=Error('Quota unavailable');error.terminal=response.status<500;throw error;}
      const reader=response.body.getReader();const chunks=[];let size=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048)throw Error('Invalid quota response');chunks.push(value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(result?.schema!==(q.idempotency?2:1)||(q.idempotency&&result.operation_id!==operationId)||typeof result.allowed!=='boolean'||!Number.isInteger(result.remaining)||result.remaining<0||result.remaining>q.limit||
         !Number.isInteger(result.reset_at)||result.reset_at<=0||!Number.isInteger(result.retry_after_seconds)||
         (result.allowed&&(result.reason!=='account_quota_allowed'||result.retry_after_seconds!==0))||
         (!result.allowed&&(result.reason!=='account_quota_exceeded'||result.retry_after_seconds<1||result.retry_after_seconds>q.windowSeconds)))throw Error('Invalid quota response');
       break;
       } catch(error) {
         signal.throwIfAborted();
         if(q.idempotency&&!error.terminal)check.reason='account_quota_outcome_unknown';
         if(!q.idempotency||attempt===1||error.terminal)throw error;
       }
      }
      check.decision=result.allowed?'allow':'deny';check.reason=result.reason;
      if(!result.allowed&&q.mode==='enforce')denial={reason:result.reason,status:429,retryAfterSeconds:result.retry_after_seconds};
    } catch {
      if(q.mode==='enforce'&&q.failureMode==='closed')denial={reason:check.reason,status:503};
    }
    signal.throwIfAborted();check.durationMs=performance.now()-started;
    return {check,denial};
  };
}
