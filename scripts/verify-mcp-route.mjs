import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function verifyMCPRoute({resource,token,timeoutMs=2000}){
 const checks=[];let client;
 const report=passed=>({schema:1,passed,checks,coverage:'selected_local_mcp_protocol_only',toolCallsSent:0,unverified:['tool authorization and tenant ownership','callback execution and side effects','effective shared limits and failure policies','reporting and model budgets','alternate routes']});
 let endpoint;
 try{
  endpoint=new URL(resource);
  if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/mcp'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||typeof token!=='string'||!token||token.length>16384||/[\r\n]/.test(token)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error();
 }catch{checks.push({name:'configuration',status:'unconfigured',remediation:'Use an owned HTTP loopback /mcp route and a server-provided token; no production endpoints.'});return report(false);}
 const metadata=new URL('/.well-known/oauth-protected-resource/mcp',endpoint);
 const boundedFetch=async(url,options={})=>{
  const target=new URL(url);
  if(target.origin!==endpoint.origin||![endpoint.pathname,metadata.pathname].includes(target.pathname)||target.search||target.hash)throw Error('Unexpected destination');
  const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(options.signal?[options.signal]:[])]);
  const response=await fetch(target,{...options,redirect:'error',signal});
  const parts=[];let bytes=0;const reader=response.body?.getReader();
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536){await reader.cancel();throw Error('Response limit');}parts.push(Buffer.from(value));}
  return new Response([204,205,304].includes(response.status)?null:Buffer.concat(parts),{status:response.status,headers:response.headers});
 };
 let stage='missing_credentials';
 try{
  const ping=JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'});
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'};
  const missing=await boundedFetch(endpoint,{method:'POST',headers,body:ping});
  if(missing.status!==401||!missing.headers.get('www-authenticate')?.includes('resource_metadata='))throw Error();
  checks.push({name:stage,status:'verified'});
  stage='invalid_credentials';
  const invalid=await boundedFetch(endpoint,{method:'POST',headers:{...headers,Authorization:'Bearer webdecoy-invalid-synthetic-credential'},body:ping});
  if(invalid.status!==401)throw Error();checks.push({name:stage,status:'verified'});
  stage='resource_metadata';
  const response=await boundedFetch(metadata);if(response.status!==200)throw Error();
  const description=await response.json();
  if(description.resource!==endpoint.href||!Array.isArray(description.authorization_servers)||!description.authorization_servers.length)throw Error();
  checks.push({name:stage,status:'verified'});
  stage='official_client';
  client=new Client({name:'webdecoy-route-check',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(endpoint,{fetch:boundedFetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  await client.ping();
  const listed=await client.listTools();
  if(!Array.isArray(listed.tools))throw Error();
  checks.push({name:stage,status:'verified',advertisedTools:listed.tools.length});
  return report(true);
 }catch{checks.push({name:stage,status:'failed',remediation:'Check the selected handler, token verifier, resource URL, protocol compatibility and local server availability. Tool protection remains unverified.'});return report(false);}
 finally{await client?.close().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const result=await verifyMCPRoute({resource:process.env.MCP_RESOURCE,token:process.env.MCP_TEST_TOKEN});console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
