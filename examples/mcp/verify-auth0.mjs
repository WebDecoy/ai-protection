// Owned provider verification: real issuer/JWKS, loopback MCP, harmless callbacks.
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createProtectedMCPHandler} from './dist/server.js';
import {createAuth0Authenticator} from '../auth0/authenticate.mjs';

export async function verifyAuth0({issuer,resource,subject,organization,machineClientId,token,fetcher}) {
  const machine=typeof machineClientId==='string' && machineClientId.length>0;
  if((machine ? Boolean(subject||organization)||!/^[A-Za-z0-9_-]{1,128}$/.test(machineClientId) : !subject||!organization) || typeof token!=='string' || token.length>16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw Error('Invalid verification configuration');
  const external=new URL(resource);
  const authenticate=createAuth0Authenticator({issuer,audience:resource,fetcher,
    resolveTenant:claims=>(machine
      ? claims.subject===machineClientId+'@clients'&&claims.clientId===machineClientId&&claims.organizationId===undefined
      : claims.subject===subject&&claims.organizationId===organization)?'owned-tenant':null});
  // Confirm real credential and configured membership before opening the test server.
  const caller=await authenticate(new Request(resource,{headers:{Authorization:'Bearer '+token}}));
  if(!caller.scopes.includes('records:read')||caller.scopes.includes('records:export'))throw Error('Use a read-only test token');
  let reads=0,exports=0;
  const handler=createProtectedMCPHandler({resource,authorizationServer:issuer,authenticate,policyVersion:'auth0_verification_v1',tools:{
    'records.read':{description:'Read an owned synthetic record',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},requiredScopes:['records:read'],
      validate:args=>args!==null&&typeof args==='object'&&Object.keys(args).length===1&&typeof args.id==='string',
      authorize:({caller,args})=>caller.tenant==='owned-tenant'&&args.id==='owned-record',
      execute:()=>{reads++;return {content:[{type:'text',text:'synthetic record'}]};}},
    'records.export':{description:'Forbidden synthetic export',inputSchema:{type:'object'},requiredScopes:['records:export'],validate:()=>true,authorize:()=>false,
      execute:()=>{exports++;throw Error('Forbidden callback');}},
  }});
  const server=createServer((req,res)=>{void handler(req,res);});
  server.requestTimeout=10000;server.headersTimeout=10000;
  const client=new Client({name:'webdecoy-owned-auth0-check',version:'1'});
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const local=`http://127.0.0.1:${server.address().port}`;
    const boundedFetch=(url,options={})=>{
      if(new URL(url).origin!==local)throw Error('Unexpected verification destination');
      // Node's fetch may discard an explicit Host header. Use a bounded direct
      // loopback request so the configured external resource host reaches MCP.
      return new Promise((resolve,reject)=>{
        const headers=Object.fromEntries(new Headers(options.headers));
        headers.host=external.host;
        const request=httpRequest(url,{method:options.method??'GET',headers,
          signal:AbortSignal.any([AbortSignal.timeout(5000),...(options.signal?[options.signal]:[])])},response=>{
          const chunks=[];let size=0;
          response.on('data',chunk=>{size+=chunk.length;if(size>65536)request.destroy(Error('Verification response too large'));else chunks.push(chunk);});
          response.on('error',reject);
          response.on('end',()=>{
            const status=response.statusCode;
            if(status>=300&&status<400){reject(Error('Unexpected redirect'));return;}
            const responseHeaders=new Headers();
            for(const [key,value] of Object.entries(response.headers))if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);
            resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders}));
          });
        });
        request.on('error',reject);request.end(options.body??undefined);
      });
    };
    const metadata=await boundedFetch(local+'/.well-known/oauth-protected-resource/mcp',{headers:{Host:external.host}});
    assert.equal(metadata.status,200);
    const document=await metadata.json();assert.equal(document.resource,resource);assert.deepEqual(document.authorization_servers,[issuer]);
    const body=JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'records.read',arguments:{id:'owned-record'}}});
    const raw=async bearer=>{
      const response=await boundedFetch(local+'/mcp',{method:'POST',headers:{Host:external.host,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(bearer?{Authorization:'Bearer '+bearer}:{})},body});
      const status=response.status,challenge=response.headers.get('www-authenticate');await response.body?.cancel();return {status,challenge};
    };
    const missing=await raw();assert.equal(missing.status,401);assert.match(missing.challenge,/resource_metadata=/);
    const pieces=token.split('.');pieces[2]=(pieces[2][0]==='A'?'B':'A')+pieces[2].slice(1);
    assert.equal((await raw(pieces.join('.'))).status,401);
    await client.connect(new StreamableHTTPClientTransport(new URL(local+'/mcp'),{
      fetch:boundedFetch,requestInit:{headers:{Host:external.host,Authorization:'Bearer '+token}}
    }));
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['records.read']);
    const read=await client.callTool({name:'records.read',arguments:{id:'owned-record'}});
    assert.equal(read.isError,undefined);assert.equal(read.content[0].text,'synthetic record');
    const cross=await client.callTool({name:'records.read',arguments:{id:'other-tenant-record'}});
    assert.equal(cross.isError,true);
    // Raw call captures the HTTP scope challenge, rather than initiating any login flow.
    const denied=await boundedFetch(local+'/mcp',{method:'POST',headers:{Host:external.host,Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'records.export',arguments:{}}})});
    assert.equal(denied.status,403);assert.match(denied.headers.get('www-authenticate'),/insufficient_scope/);await denied.body?.cancel();
    assert.equal(reads,1);assert.equal(exports,0);
    return {schema:1,passed:true,allowed_callbacks:reads,forbidden_callbacks:exports,checks:['provider_signature_and_membership','resource_metadata','missing_credentials','tampered_signature','official_client','scope_filtered_listing','allowed_read','tenant_denial','scope_challenge']};
  } finally {
    await client.close().catch(()=>{});await handler.flush();
    server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}

async function main(){
  const path=process.env.AUTH0_TOKEN_FILE;
  if(!path)throw Error('AUTH0_TOKEN_FILE required');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let token;
  try {
    const info=await file.stat();
    if(!info.isFile()||info.size>16384||(info.mode&0o077)!==0)throw Error('Use a private token file');
    token=(await file.readFile('utf8')).trim();
  } finally {await file.close();}
  const result=await verifyAuth0({issuer:process.env.AUTH0_ISSUER,resource:process.env.MCP_RESOURCE,
    subject:process.env.AUTH0_SUBJECT,organization:process.env.AUTH0_ORGANIZATION,machineClientId:process.env.AUTH0_MACHINE_CLIENT_ID,token});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.error('Auth0 verification failed. Check private token file, issuer, resource, membership and records:read scope. No credentials logged.');process.exitCode=1;});
}
