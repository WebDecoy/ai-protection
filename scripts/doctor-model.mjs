import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAIProtection,createAIBudget,BudgetDenied} from '../fetch.mjs';

// Synthetic values only. The client IP is from TEST-NET-2 (RFC 5737).
const doctorIP='198.51.100.7',doctorKey='webdecoy-doctor-synthetic-key';
const organization='00000000-0000-4000-8000-0000000000d0';

/**
 * Stand-in WebDecoy runtime on loopback. Answers the SDK's control and reporting
 * contracts from a scripted state and records what it receives. It cannot verify
 * signed browser receipts and never returns a clean receipt verdict.
 */
async function startStandIn(propertyId){
 const state={detect:'allow',budget:'grant',outage:false};
 const seen={config:0,detect:0,quota:0,concurrency:0,budget:0,reports:[],usage:[],browserTokens:[]};
 const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 const server=createServer(async(req,res)=>{
  const chunks=[];let size=0;
  for await(const c of req){size+=c.length;if(size>65536){json(res,413,{});return;}chunks.push(c);}
  if(state.outage){json(res,503,{error:'doctor_outage'});return;}
  let body={};try{body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{json(res,400,{});return;}
  const path=(req.url??'').split('?')[0];
  if(path==='/api/v1/sdk/ai-abuse/config'){seen.config++;json(res,200,{schema:1,property_id:propertyId,organization_id:organization,mode:'enforce',observe:true,enforce:true});return;}
  if(path==='/api/v1/sdk/detect'){
   seen.detect++;const evidence=body.browser_evidence;
   if(evidence)seen.browserTokens.push(evidence.token?'present':'missing');
   json(res,200,{decision_mode:'unified_v1',decision:state.detect,...(evidence?{browser_evidence:evidence.token?'invalid':'missing'}:{})});return;
  }
  if(path==='/api/v1/sdk/ai-abuse/quota'){seen.quota++;json(res,200,{schema:body.schema,...(body.operation_id?{operation_id:body.operation_id}:{}),allowed:true,remaining:Math.max(0,body.limit-1),reset_at:Math.floor(Date.now()/1000)+body.window_seconds,retry_after_seconds:0,reason:'account_quota_allowed'});return;}
  if(path==='/api/v1/sdk/ai-abuse/concurrency'){
   seen.concurrency++;
   const reason={acquire:'concurrency_allowed',renew:'concurrency_renewed',release:'concurrency_released'}[body.operation];
   json(res,200,{schema:1,allowed:true,granted:body.operation!=='release',reason,retry_after_seconds:0,lease_id:body.lease_id??randomUUID(),valid_for_ms:Math.min(30000,(body.ttl_seconds??30)*1000)});return;
  }
  if(path==='/api/v1/sdk/ai-abuse/budget'){
   seen.budget++;
   if(body.operation==='settle'){json(res,200,{schema:1,allowed:true,granted:false,overrun:false,reason:'budget_settled',retry_after_seconds:0});return;}
   json(res,200,state.budget==='exceed'?{schema:1,allowed:false,granted:false,overrun:false,reason:'budget_exceeded',retry_after_seconds:60}:{schema:1,allowed:true,granted:true,overrun:false,reason:'budget_allowed',retry_after_seconds:0,reservation_id:randomUUID()});return;
  }
  if(path==='/api/v1/sdk/ai-abuse/reports'){seen.reports.push(body);json(res,202,{});return;}
  if(path==='/api/v1/sdk/ai-abuse/usage'){seen.usage.push(body);json(res,202,{});return;}
  json(res,404,{});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}`,state,seen,close:()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}};
}

/** A model provider stand-in: counts calls, honors cancellation, never contacts a provider. */
function stubProvider(){
 const stub={calls:0,aborted:0};
 stub.run=async({signal,stream=false,wait=false,price})=>{
  stub.calls++;
  if(wait){await new Promise(r=>{if(signal.aborted)return r();signal.addEventListener('abort',r,{once:true});setTimeout(r,5000);});stub.aborted+=signal.aborted?1:0;signal.throwIfAborted();}
  const usage=price?{provider:price.provider,model:price.model,inputTokens:3,outputTokens:5}:null;
  if(!stream)return {response:Response.json({output:'stub'}),finished:Promise.resolve(usage)};
  let done;const finished=new Promise(r=>done=r);
  const parts=['data: one\n\n','data: two\n\n','data: three\n\n'];let i=0;
  const body=new ReadableStream({async pull(c){if(i>=parts.length){c.close();done(usage);return;}await new Promise(r=>setTimeout(r,10));c.enqueue(new TextEncoder().encode(parts[i++]));},cancel(){done(null);}});
  return {response:new Response(body,{headers:{'Content-Type':'text/event-stream'}}),finished};
 };
 return stub;
}

const read=async r=>new TextDecoder().decode(await r.arrayBuffer());

/**
 * In-process synthetic checks for the model admission path. Builds protection
 * from your options against a loopback stand-in runtime and a counting stub
 * provider. No paid provider, real runtime or customer traffic is involved.
 */
// createProtection/createBudget default to this SDK; pass your installed package's exports to check that version instead.
export async function checkModelProtection({protection,budget,allowedContext={},deniedContext,createProtection=createAIProtection,createBudget=createAIBudget}){
 const report={schema:1,command:'model-check',passed:false,checks:[],diagnostics:{},
  overrides:['webdecoyUrl -> loopback stand-in','webdecoyKey -> synthetic','resolveClientIP -> '+doctorIP,'onObservation -> doctor sink (your sink is not called)','waitUntil -> removed (the doctor flushes)','property mode -> enforce with enforcement entitled (stand-in)'],
  notExercised:['your route handler code and its provider client','real WebDecoy detection verdicts and receipt signatures','cold-start outages (config unavailable keeps protection in observe)','shared limit exhaustion (the stand-in always admits quota and concurrency)'],
  stubProvider:{paidCalls:0}};
 if(!protection||typeof protection!=='object'||typeof protection.propertyId!=='string'){report.checks.push({name:'configuration',status:'unconfigured',remediation:'Pass your createAIProtection options, including propertyId.'});return report;}
 const standIn=await startStandIn(protection.propertyId);
 const stub=stubProvider();
 const build=()=>createProtection({...protection,webdecoyUrl:standIn.url,webdecoyKey:doctorKey,resolveClientIP:()=>doctorIP,onObservation:()=>{},waitUntil:undefined});
 let guard,meter;
 try{
  guard=build();
  if(budget)meter=createBudget({...budget,webdecoyUrl:standIn.url,webdecoyKey:doctorKey,propertyId:protection.propertyId,waitUntil:undefined});
 }catch(e){await standIn.close();report.checks.push({name:'configuration',status:'invalid',remediation:'createAIProtection or createAIBudget rejected these options; fix the startup error in your own logs first.'});return report;}
 const concurrent=!!protection.concurrency;
 const request=(signal,cookie)=>new Request('http://127.0.0.1/webdecoy-doctor',{method:'POST',signal,headers:{'Content-Type':'application/json','User-Agent':'webdecoy-doctor/1',...(cookie?{Cookie:cookie}:{})},body:'{}'});
 const invoke=(context,opts={})=>{
  const req=request(opts.signal,opts.cookie);
  return concurrent?guard.concurrent(req,({signal})=>stub.run({...opts,signal}),context)
   :guard(req,async()=>{const r=await stub.run({...opts,signal:req.signal});return r.response;},context);
 };
 const mode=protection.protectionMode??'enforce',failure=protection.detectorFailureMode??'open';
 const closed=limit=>limit&&limit.mode==='enforce'&&limit.failureMode==='closed';
 const run=async(name,fn)=>{
  const entry={name},before=stub.calls,began=performance.now();
  try{Object.assign(entry,await fn(()=>stub.calls-before));}catch(e){Object.assign(entry,{status:'failed',observed:e instanceof BudgetDenied?{budget:e.message,status:e.status}:'error',remediation:'The check threw unexpectedly; see the observed value.'});}
  entry.durationMs=Math.round(performance.now()-began);report.checks.push(entry);
 };
 try{
  await run('allowed',async calls=>{
   const r=await invoke(allowedContext);const text=await read(r);
   return r.status===200&&calls()===1&&text.includes('stub')?{status:'verified',observed:{status:200,providerCalls:1}}:
    {status:'failed',observed:{status:r.status,providerCalls:calls()},remediation:'An allowed context must reach the provider exactly once. Check allowedContext against your local rules and quota subject.'};
  });
  if(deniedContext!==undefined)await run('local_denial',async calls=>{
   const r=await invoke(deniedContext);await r.body?.cancel();
   return r.status>=400&&calls()===0?{status:'verified',observed:{status:r.status,providerCalls:0}}:
    {status:'failed',observed:{status:r.status,providerCalls:calls()},remediation:'deniedContext reached the provider. Enforce the local rule (mode: enforce) that should refuse it.'};
  });
  await run('detector_block',async calls=>{
   standIn.state.detect='block';
   try{
    const r=await invoke(allowedContext);await r.body?.cancel();
    if(mode==='enforce')return r.status===403&&calls()===0?{status:'verified',observed:{status:403,providerCalls:0}}:{status:'failed',observed:{status:r.status,providerCalls:calls()},remediation:'A block verdict in enforce mode must stop the provider call.'};
    return r.status===200&&calls()===1?{status:'verified',observed:{status:200,providerCalls:1,mode:'observe'},note:'protectionMode is observe: a block verdict is recorded, not enforced.'}:{status:'failed',observed:{status:r.status,providerCalls:calls()},remediation:'In observe mode a block verdict must not stop the call.'};
   }finally{standIn.state.detect='allow';}
  });
  await run('streaming',async calls=>{
   const r=await invoke(allowedContext,{stream:true});const text=await read(r);
   const parts=text.split('\n\n').filter(Boolean);
   return calls()===1&&parts.join('|')==='data: one|data: two|data: three'?{status:'verified',observed:{chunks:3,providerCalls:1,contentType:r.headers.get('content-type')}}:
    {status:'failed',observed:{chunks:parts.length,providerCalls:calls()},remediation:'The protected response must be the provider stream, unchanged and in order.'};
  });
  await run('cancellation',async calls=>{
   const controller=new AbortController(),abortedBefore=stub.aborted;
   const pending=invoke(allowedContext,{signal:controller.signal,wait:true}).then(r=>r.body?.cancel(),e=>e);
   for(let i=0;i<200&&calls()===0;i++)await new Promise(r=>setTimeout(r,5));
   controller.abort();await pending;
   for(let i=0;i<100&&stub.aborted===abortedBefore;i++)await new Promise(r=>setTimeout(r,5));
   return calls()===1&&stub.aborted>abortedBefore?{status:'verified',observed:{providerCalls:1,providerSawAbort:true}}:
    {status:'failed',observed:{providerCalls:calls(),providerSawAbort:stub.aborted>abortedBefore},remediation:'Pass the request (or concurrent runtime) signal to your provider call so cancellation stops the work.'};
  });
  await run('outage',async calls=>{
   // Warm instance: the property config was cached by the calls above.
   const expectDeny=closed(protection.accountQuota)||(concurrent&&closed(protection.concurrency))||(mode==='enforce'&&failure==='closed');
   standIn.state.outage=true;
   try{
    const r=await invoke(allowedContext);await r.body?.cancel();
    const ok=expectDeny?r.status===503&&calls()===0:r.status===200&&calls()===1;
    return ok?{status:'verified',observed:{status:r.status,providerCalls:calls()},expected:expectDeny?'deny_503':'allow_degraded'}:
     {status:'failed',observed:{status:r.status,providerCalls:calls()},expected:expectDeny?'deny_503':'allow_degraded',remediation:'Outage behavior differs from your configured failure modes.'};
   }finally{standIn.state.outage=false;}
  });
  if(meter){
   const priceId=Object.keys(budget.prices)[0],price=budget.prices[priceId];
   await run('budget_settlement',async calls=>{
    const req=request();const decision=await guard.check(req,allowedContext);
    const run=await meter.run(allowedContext,{requestId:decision.id,priceId,maxInputTokens:100,maxOutputTokens:100},({signal})=>stub.run({signal,price}).then(r=>({value:r.response,finished:r.finished})));
    await run.value.body?.cancel();const accounting=await run.accounting;
    await guard.report(decision,{handlerAttempted:true,status:200});
    await Promise.all([guard.flush(),meter.flush()]);
    const linked=standIn.seen.usage.filter(u=>u.request_id===decision.id).map(u=>u.phase);
    const admission=standIn.seen.reports.some(r=>r.request_id===decision.id);
    return accounting.reason==='budget_settled'&&calls()===1&&admission&&linked.includes('start')&&linked.includes('finish')?
     {status:'verified',observed:{accounting:accounting.reason,providerCalls:1,usagePhases:linked,admissionReport:true}}:
     {status:'failed',observed:{accounting:accounting.reason,providerCalls:calls(),usagePhases:linked,admissionReport:admission},remediation:'Pass decision.id as requestId on budget.run and keep reporting enabled so admission and usage reports share one request ID.'};
   });
   await run('budget_denied',async calls=>{
    standIn.state.budget='exceed';
    try{
     const attempt=await meter.run(allowedContext,{priceId,maxInputTokens:100,maxOutputTokens:100},({signal})=>stub.run({signal,price}).then(r=>({value:r.response,finished:r.finished}))).then(()=>null,e=>e);
     if((budget.mode??'observe')==='enforce')return attempt instanceof BudgetDenied&&attempt.status===429&&calls()===0?{status:'verified',observed:{status:429,providerCalls:0}}:{status:'failed',observed:{providerCalls:calls()},remediation:'An exceeded budget in enforce mode must stop the provider call.'};
     return attempt===null&&calls()===1?{status:'verified',observed:{providerCalls:1,mode:'observe'},note:'Budget mode is observe: exceeded budgets are recorded, not enforced.'}:{status:'failed',observed:{providerCalls:calls()},remediation:'In observe mode an exceeded budget must not stop the call.'};
    }finally{standIn.state.budget='grant';}
   });
  }
  await Promise.all([guard.flush(),meter?.flush()]);
  // Browser receipts: forwarding only. Validity is signed by WebDecoy and is not checked here.
  if(protection.browserEvidenceOrigin){
   const before=standIn.seen.browserTokens.length,cookieName='__Host-wd_runtime_'+protection.propertyId.toLowerCase();
   const r=await invoke(allowedContext,{cookie:`${cookieName}=synthetic.receipt; unrelated=secret`});await r.body?.cancel();
   const forwarded=standIn.seen.browserTokens.slice(before).includes('present');
   report.diagnostics.browserReceipts={status:forwarded?'forwarded':'not_forwarded',missingReceipt:standIn.seen.browserTokens.includes('missing')?'fails_open':'not_observed',validity:'not_verified_locally',
    note:'Receipts come from the opted-in WebDecoy tag in a real browser. A receipt-free request still reaches the provider.'};
  }else report.diagnostics.browserReceipts={status:'unconfigured',note:'Optional browser evidence. Not required for server or machine callers.'};
  report.diagnostics.reporting=protection.reportToWebDecoy===false?{status:'disabled',note:'reportToWebDecoy is false: admission outcomes are not sent, so dashboard correlation is unavailable.'}:
   {status:standIn.seen.reports.length?'delivered_to_stand_in':'not_observed',admissionReports:standIn.seen.reports.length,hostLifecycle:protection.waitUntil?'configured':'unconfigured',
    note:protection.waitUntil?'Your waitUntil keeps reports alive after the response.':'Without waitUntil (or Next.js after()), serverless hosts may end before reports are sent.'};
  report.diagnostics.requestCorrelation=!meter?{status:'unconfigured',note:'No budget options: there are no model-attempt reports to correlate.'}:
   report.checks.find(c=>c.name==='budget_settlement')?.status==='verified'?{status:'verified_for_documented_pattern',note:'Verified with check() then budget.run({requestId: decision.id}). The doctor cannot see your handler: it must pass decision.id the same way.'}:{status:'failed',note:'See the budget_settlement check.'};
  report.diagnostics.budget=meter?{status:'configured',mode:budget.mode??'observe',failureMode:budget.failureMode??'open',settlement:report.checks.find(c=>c.name==='budget_settlement')?.observed?.accounting??'not_observed'}:{status:'unconfigured'};
 }finally{await standIn.close();}
 report.stubProvider={calls:stub.calls,paidCalls:0};
 report.standIn={detect:standIn.seen.detect,quota:standIn.seen.quota,concurrency:standIn.seen.concurrency,budget:standIn.seen.budget,reports:standIn.seen.reports.length,usage:standIn.seen.usage.length};
 report.passed=report.checks.every(c=>c.status==='verified');
 return report;
}
