import {createServer} from 'node:http';
import {createProtectedMCPHandler} from '@webdecoy/ai-protection/mcp';
import {createAuth0Authenticator} from '../auth0/authenticate.mjs';
import {createBoundedWorkTools} from './work-tools.mjs';
for(const name of ['AUTH0_ISSUER','AUTH0_SUBJECT','AUTH0_ORGANIZATION','WEBDECOY_URL','WEBDECOY_KEY','WEBDECOY_PROPERTY_ID','WEBDECOY_SUBJECT_SECRET'])if(!process.env[name])throw Error(`${name} is required`);
const port=Number(process.env.PORT??8093),resource=process.env.MCP_RESOURCE??`http://127.0.0.1:${port}/mcp`;
const authenticate=createAuth0Authenticator({issuer:process.env.AUTH0_ISSUER,audience:resource,resolveTenant:({subject,organizationId})=>subject===process.env.AUTH0_SUBJECT&&organizationId===process.env.AUTH0_ORGANIZATION?'a':null});
const {tools}=createBoundedWorkTools();
const handler=createProtectedMCPHandler({resource,authorizationServer:process.env.AUTH0_ISSUER,authenticate,policyVersion:'work_v1',tools,
 sharedRuntime:{webdecoyUrl:process.env.WEBDECOY_URL,webdecoyKey:process.env.WEBDECOY_KEY,propertyId:process.env.WEBDECOY_PROPERTY_ID,subjectSecret:process.env.WEBDECOY_SUBJECT_SECRET}});
const server=createServer((req,res)=>{void handler(req,res);});server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(port,'127.0.0.1',()=>console.log(`Bounded synthetic work example: ${resource}`));
