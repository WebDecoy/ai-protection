import {createProtectedMCPHandler} from '../mcp.mjs';

/** Inspect trusted server options without calling authentication, policy or tools. */
export function inspectMCPControls(options){
 const base={schema:1,coverage:'configuration_only',routes:['/mcp','/.well-known/oauth-protected-resource/mcp'],uncovered:'alternate routes and unwrapped handlers',browserReceipts:'unsupported_by_mcp_adapter',modelBudget:'not_inspected',modelRequestCorrelation:'not_observed'};
 try{
  // Use the adapter's actual startup validation rather than duplicating its rules.
  createProtectedMCPHandler(options);
  const runtime=options.sharedRuntime;
  const controls=['callerQuota','tenantQuota','concurrency','tenantConcurrency','work'];
  const tools=Object.entries(options.tools).map(([name,tool])=>({name,authentication:'required',applicationAuthorization:'required',additionalPolicy:typeof tool.policy==='function',requiredScopeCount:tool.requiredScopes.length,
   controls:controls.map(kind=>{
    const config=tool.limits?.[kind];
    if(!config)return {kind,status:'unconfigured'};
    const mode=config.mode??'observe',failureMode=config.failureMode??'open';
    return {kind,status:'configured',mode,failureMode,timeoutMs:config.timeoutMs??1000,exhaustion:mode==='enforce'?'deny':'observe',unavailable:mode==='enforce'&&failureMode==='closed'?'deny':'allow',behavior:'not_observed'};
   })}));
  return {...base,status:'valid_configuration',tools,pauses:{caller:runtime?.callerPause?'configured':'unconfigured',tool:runtime?.toolPause?'configured':'unconfigured',failureMode:'open',alreadyRunningWork:'not_revoked'},reporting:{status:runtime?'configured':'unconfigured',delivery:'not_verified',timeoutMs:runtime?(runtime.reportingTimeoutMs??1000):null,maxPending:runtime?(runtime.maxPendingReports??100):null},remediation:'Run bounded owned calls and inspect retained action evidence to verify behavior. Configured modes do not prove delivery or enforcement.'};
 }catch{
  return {...base,status:'invalid_configuration',tools:[],reporting:{delivery:'not_verified'},remediation:'Check the adapter startup error in your private application logs and fix the selected options. No authentication or tool callbacks were invoked.'};
 }
}

/** Bounded local evidence collector. Compose these hooks with existing observers. */
export function collectMCPDiagnostics(){
 const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
 const events=new Map(),receipts=new Map();let dropped=0;
 const outcomes=['not_attempted','attempted','completed','unknown'];
 const knownChecks=new Set(['caller_quota','tenant_quota','concurrency','tenant_concurrency','tool_work','tool_work_settlement','caller_pause','tool_pause']);
 return {
  onEvent(event){
   if(!uuid.test(event?.eventId??'')||!uuid.test(event?.actionId??'')||!outcomes.includes(event?.outcome))return;
   if(!events.has(event.eventId)&&events.size>=1000){dropped++;return;}
   const checks=(event.checks??[]).slice(0,32).filter(c=>knownChecks.has(c.id)&&['observe','enforce'].includes(c.mode)&&['allow','deny','unavailable'].includes(c.decision)).map(c=>({kind:c.id,mode:c.mode,decision:c.decision}));
   events.set(event.eventId,{actionId:event.actionId,outcome:event.outcome,checks});
  },
  onReport(receipt){
   if(!uuid.test(receipt?.eventId??'')||!uuid.test(receipt?.actionId??'')||!['accepted','unavailable'].includes(receipt?.status))return;
   if(!receipts.has(receipt.eventId)&&receipts.size>=1000){dropped++;return;}
   receipts.set(receipt.eventId,{actionId:receipt.actionId,status:receipt.status});
  },
  snapshot(){
   const reporting={accepted:0,unavailable:0,missingOrPending:0,retainedEvidence:'not_verified'};
   const phases=Object.fromEntries(outcomes.map(k=>[k,0])),controls=new Map();
   for(const [id,event]of events){
    phases[event.outcome]++;
    const receipt=receipts.get(id);
    if(receipt?.actionId===event.actionId)reporting[receipt.status]++;else reporting.missingOrPending++;
    for(const check of event.checks){const key=check.kind+':'+check.mode+':'+check.decision;controls.set(key,{...check,observations:(controls.get(key)?.observations??0)+1});}
   }
   return {schema:1,coverage:'locally_observed_wrapped_actions',phases,controls:[...controls.values()],reporting,dropped,uncovered:'alternate routes and unwrapped handlers',modelRequestCorrelation:'not_observed',modelBudgetSettlement:'not_observed',browserReceipts:'unsupported_by_mcp_adapter'};
  }
 };
}
