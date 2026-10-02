import {createServer} from 'node:http';
import {createProtectedMCPHandler} from './dist/server.js';
import {createAuth0Authenticator} from '../auth0/authenticate.mjs';
for(const key of ['AUTH0_ISSUER','AUTH0_SUBJECT','AUTH0_ORGANIZATION'])if(!process.env[key])throw Error(`${key} required for the owned demonstration`);
const port=Number(process.env.PORT??8093);
const resource=process.env.MCP_RESOURCE??`http://127.0.0.1:${port}/mcp`;
const authenticate=createAuth0Authenticator({issuer:process.env.AUTH0_ISSUER,audience:resource,
  // Demonstration allowlist only. Replace with current application membership.
  resolveTenant:({subject,organizationId})=>subject===process.env.AUTH0_SUBJECT&&organizationId===process.env.AUTH0_ORGANIZATION?'tenant-a':null});
const handler=createProtectedMCPHandler({resource,authorizationServer:process.env.AUTH0_ISSUER,authenticate,policyVersion:'records_v1',
  onEvent:event=>console.log(JSON.stringify(event)),
  tools:{
    'records.read':{description:'Read an owned demonstration record',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},requiredScopes:['records:read'],
      validate:args=>args!==null&&typeof args==='object'&&Object.keys(args).length===1&&typeof args.id==='string',
      authorize:({caller,args})=>caller.tenant==='tenant-a'&&args.id==='record-a',
      execute:({caller,args})=>{if(caller.tenant!=='tenant-a'||args.id!=='record-a')throw Error('Permission changed');return {content:[{type:'text',text:'Owned demonstration record'}]};}},
    'records.export':{description:'Export demonstration records',inputSchema:{type:'object',additionalProperties:false},requiredScopes:['records:export'],
      validate:args=>args!==null&&typeof args==='object'&&Object.keys(args).length===0,authorize:()=>false,
      execute:()=>{throw Error('Forbidden export reached execution');}},
  }});
const server=createServer((req,res)=>{void handler(req,res);});
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(port,'127.0.0.1',()=>console.log(`Protected MCP demonstration: ${resource}`));
