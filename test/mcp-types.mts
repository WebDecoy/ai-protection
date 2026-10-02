import {createServer} from 'node:http';
import {createProtectedMCPHandler, type ProtectedMCPOptions, type ProtectedTool} from '@webdecoy/ai-protection/mcp';

const read: ProtectedTool = {
  description:'Read an owned record',inputSchema:{type:'object'},requiredScopes:['read'],
  validate:args=>args!==null&&typeof args==='object',
  authorize:({caller})=>caller.tenant==='trusted',
  execute:({signal})=>{signal?.throwIfAborted();return {content:[{type:'text',text:'owned'}]};},
};
const options: ProtectedMCPOptions = {
  resource:'https://example.test/mcp',authorizationServer:'https://issuer.test/',policyVersion:'v1',
  authenticate:async(request,{signal})=>{
    signal.throwIfAborted();void request.headers;
    return {schema:1,subject:'user',tenant:'trusted',issuer:'https://issuer.test/',authenticationMethod:'oauth',expiresAt:Date.now()+60000,scopes:['read']};
  },
  tools:{read},
};
createServer(createProtectedMCPHandler(options));
// @ts-expect-error Tool callbacks must return a complete MCP result.
const bad: ProtectedTool = {...read,execute:()=>new Response('not an MCP result')};
// @ts-expect-error Unverified token text is not a trusted caller.
createProtectedMCPHandler({...options,authenticate:async()=>'bearer-token'});
void bad;
