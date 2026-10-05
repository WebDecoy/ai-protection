import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const baseReport=()=>({schema:1,coverage:'not_verified',checks:[],unverified:['selected route wiring','application authentication and tenant authorization','effective per-tool modes and failure policies','tool dispatch and cancellation','report delivery and request correlation','model budget settlement'],browserReceipts:'not_required_for_machine_callers'});
/** Read-only config probe. Does not execute tools, reserve work or send reports. */
export async function diagnoseMCP({baseURL='https://ai-protection.webdecoy.com',key,propertyId,timeoutMs=2000},fetcher=fetch){
 const report=baseReport();
 const finish=(status,reason,remediation)=>({...report,checks:[{name:'property_runtime_config',status,reason,remediation}]});
 let url;
 try{
  url=new URL(baseURL);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))))throw Error();
  if(typeof key!=='string'||!key||key.length>8192||/[\r\n]/.test(key)||!uuid.test(propertyId??'')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error();
 }catch{return finish('unconfigured','invalid_configuration','Provide a property-scoped key, property UUID and HTTPS runtime origin (HTTP only on loopback).');}
 try{
  const response=await fetcher(new URL('/api/v1/sdk/ai-abuse/config',url),{method:'GET',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(response.status!==200){
   await response.body?.cancel();
   const failures={400:['unconfigured','property_key_required','Use a property-scoped server key.'],401:['rejected','credentials_rejected','Check or rotate the property server key.'],403:['rejected','property_unavailable','Check key/property ownership and access.'],404:['unsupported','config_route_missing','Use the AI Protection gateway origin serving the SDK config route.']};
   const [status,reason,remediation]=failures[response.status]??['unavailable','runtime_unavailable','Check runtime availability and retry the diagnostic.'];
   return finish(status,reason,remediation);
  }
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body?.cancel();return finish('unsupported','invalid_contract','Expected JSON schema 1 from the runtime config endpoint.');}
  const reader=response.body?.getReader();if(!reader)throw Error();
  let size=0;const parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return finish('unsupported','oversized_contract','Expected a config response no larger than 16 KiB.');}parts.push(Buffer.from(value));}
  let config;try{config=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return finish('unsupported','invalid_contract','Expected valid JSON schema 1.');}
  if(!config||config.schema!==1||!uuid.test(config.property_id??'')||!['observe','enforce'].includes(config.mode)||typeof config.enforce!=='boolean'||config.observe!==true)return finish('unsupported','invalid_contract','Upgrade to a supported schema-1 runtime config contract.');
  if(config.property_id.toLowerCase()!==propertyId.toLowerCase())return finish('rejected','property_mismatch','Use the server key belonging to the selected property.');
  return {...finish('verified','property_binding_verified','Property binding is verified; run route-specific synthetic checks to verify enforcement.'),runtime:{configSchema:1,configuredPropertyMode:config.mode,cloudEnforcementEntitled:config.enforce},effectiveToolControls:'not_verified'};
 }catch{return finish('unavailable','request_failed','Check TLS, networking, redirects and runtime response time; no automatic retry was performed.');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const result=await diagnoseMCP({baseURL:process.env.WEBDECOY_URL,key:process.env.WEBDECOY_KEY,propertyId:process.env.WEBDECOY_PROPERTY_ID});
 console.log(JSON.stringify(result,null,2));
 if(result.checks[0].status!=='verified')process.exitCode=1;
}
