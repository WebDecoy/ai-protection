import type {IncomingMessage, ServerResponse} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema,ErrorCode,McpError,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {createActionProtection,ActionDenied,type TrustedCaller,type ActionDefinition,type ActionEvent,type ActionInput,type ActionRuntime} from '../../../actions.mjs';

export interface ProtectedTool extends ActionDefinition {
  description: string;
  inputSchema: Tool['inputSchema'];
}
export interface ProtectedMCPOptions {
  resource: string;
  authorizationServer: string;
  authenticate(request: Request, options: {signal: AbortSignal}): Promise<TrustedCaller>;
  policyVersion: string;
  sharedRuntime?: ActionRuntime;
  tools: Record<string,ProtectedTool>;
  allowedOrigins?: string[];
  onEvent?(event: ActionEvent): void | Promise<void>;
}
const metadataPath='/.well-known/oauth-protected-resource/mcp';
export function createProtectedMCPHandler(options: ProtectedMCPOptions) {
  const resource=new URL(options.resource),issuer=new URL(options.authorizationServer);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(resource.hostname);
  if((resource.protocol!=='https:'&&!(loopback&&resource.protocol==='http:'))||resource.pathname!=='/mcp'||resource.search||resource.hash||resource.username||resource.password||issuer.protocol!=='https:'||issuer.search||issuer.hash||issuer.username||issuer.password)throw Error('Invalid MCP resource configuration');
  const metadataURL=new URL(metadataPath,resource).href;
  const tools=Object.fromEntries(Object.entries(options.tools).map(([name,t])=>[name,{...t,requiredScopes:[...t.requiredScopes],inputSchema:structuredClone(t.inputSchema)}]));
  // Validate the closed registry at startup, not only after a client arrives.
  createActionProtection({policyVersion:options.policyVersion,authenticate:options.authenticate,actions:tools,sharedRuntime:options.sharedRuntime});
  for(const tool of Object.values(tools))for(const scope of tool.requiredScopes)if(!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))throw Error('Invalid OAuth scope');
  const active=new Map<string,{controller:AbortController;started:boolean}>();
  const scopes=[...new Set(Object.values(tools).flatMap(t=>t.requiredScopes))];
  const origins=new Set(options.allowedOrigins??[]);
  function respond(res:ServerResponse,status:number,error:string,headers:Record<string,string>={}){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify({error}));}
  function challenge(res:ServerResponse,status:number,scope?:string[]){respond(res,status,status===401?'unauthorized':'insufficient_scope',{'WWW-Authenticate':`Bearer resource_metadata="${metadataURL}"${status===401?'':`, error="insufficient_scope", scope="${scope!.join(' ')}"`}`});}
  return async function handle(req:IncomingMessage,res:ServerResponse):Promise<void> {
    const disconnected=new AbortController();
    req.once('aborted',()=>disconnected.abort());
    res.once('close',()=>{if(!res.writableEnded)disconnected.abort();});
    try {
      if(req.headers.host!==resource.host){respond(res,403,'invalid_host');return;}
      if(req.headers.origin && !origins.has(req.headers.origin)){respond(res,403,'invalid_origin');return;}
      if(req.url===metadataPath && req.method==='GET'){
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({resource:resource.href,authorization_servers:[issuer.href],scopes_supported:scopes,bearer_methods_supported:['header']}));return;
      }
      if(req.url!=='/mcp'){respond(res,404,'not_found');return;}
      if(req.method!=='POST'){respond(res,405,'method_not_allowed',{'Allow':'POST'});return;}
      // Stateless operation: no session resurrection, replay store or standalone SSE.
      if(req.headers['mcp-session-id'] || req.headers['last-event-id']){respond(res,400,'sessions_not_supported');return;}
      if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){respond(res,415,'application_json_required');return;}
      const headers=new Headers();
      for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      const original=new Request(resource,{method:'POST',headers,signal:disconnected.signal});
      let caller:TrustedCaller;
      const authDeadline=AbortSignal.timeout(1000),authSignal=AbortSignal.any([disconnected.signal,authDeadline]);
      // The action boundary also rechecks expiry before tool execution.
      try {
        caller=await Promise.race([options.authenticate(original,{signal:authSignal}),new Promise<never>((_,reject)=>{
          if(authSignal.aborted)reject(authSignal.reason);else authSignal.addEventListener('abort',()=>reject(authSignal.reason),{once:true});
        })]);
        authSignal.throwIfAborted();
        if(caller.schema!==1||!caller.subject||!caller.tenant||!Array.isArray(caller.scopes)||caller.expiresAt<=Date.now())throw Error('Invalid identity');
        caller=Object.freeze({...caller,scopes:Object.freeze([...caller.scopes])});
      }catch{if(!disconnected.signal.aborted)challenge(res,401);return;}
      let body:unknown;
      const bodyTimer=setTimeout(()=>req.destroy(),5000);
      try {
        let size=0;const chunks:Buffer[]=[];
        for await(const chunk of req){size+=chunk.length;if(size>16384){respond(res,413,'request_too_large');return;}chunks.push(Buffer.from(chunk));}
        body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }catch{if(!res.destroyed)respond(res,400,'invalid_json');return;}finally{clearTimeout(bodyTimer);}
      if(!body||typeof body!=='object'||Array.isArray(body)){respond(res,400,'single_message_required');return;}
      if(caller.expiresAt<=Date.now()){challenge(res,401);return;}
      const message=body as {jsonrpc?:string;id?:unknown;method?:string;params?:{name?:string;arguments?:Record<string,unknown>;requestId?:unknown}};
      const validID=(id:unknown)=>typeof id==='string'?id.length>0&&id.length<=512:typeof id==='number'&&Number.isSafeInteger(id);
      const callKey=(id:unknown)=>JSON.stringify([caller.issuer,caller.subject,caller.tenant,caller.clientId??null,id]);
      if(message.jsonrpc==='2.0'&&message.method==='notifications/cancelled'&&message.id===undefined){
        if(!validID(message.params?.requestId)){respond(res,400,'invalid_cancellation');return;}
        active.get(callKey(message.params!.requestId))?.controller.abort();
        res.writeHead(202,{'Cache-Control':'no-store'});res.end();return;
      }
      const guard=createActionProtection({policyVersion:options.policyVersion,authenticate:()=>caller,actions:tools,sharedRuntime:options.sharedRuntime,onEvent:options.onEvent});
      // Scope escalation belongs at HTTP level, before the SDK opens an SSE stream.
      if(message.method==='tools/call' && typeof message.params?.name==='string'){
        const definition=Object.hasOwn(tools,message.params.name)?tools[message.params.name]:undefined;
        if(definition && definition.requiredScopes.some(s=>!caller.scopes.includes(s))){
          // Run the same admission path for its sanitized denial evidence. It cannot
          // dispatch with a missing required scope, regardless of discovery results.
          try{await guard.run(message.params.name,{},null,{signal:disconnected.signal});}catch(e){if(!(e instanceof ActionDenied))throw e;}
          challenge(res,403,definition.requiredScopes);return;
        }
      }
      const key=message.method==='tools/call'&&typeof message.params?.name==='string'&&Object.hasOwn(tools,message.params.name)&&validID(message.id)?callKey(message.id):null;
      if(key&&active.has(key)){respond(res,409,'request_id_in_use');return;}
      if(key&&active.size>=128){respond(res,503,'dispatch_capacity_unavailable');return;}
      const running={controller:new AbortController(),started:false};
      if(key)active.set(key,running);
      const cleanup=()=>{if(key&&active.get(key)===running)active.delete(key);};
      res.once('close',()=>{if(!running.started)cleanup();});
      const server=new Server({name:'webdecoy-protected-records',version:'0.1.0'},{capabilities:{tools:{}}});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:false});
      res.once('close',()=>{void server.close().catch(()=>{});});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(tools)
        .filter(([,tool])=>tool.requiredScopes.every(s=>caller.scopes.includes(s)))
        .map(([name,tool])=>({name,description:tool.description,inputSchema:tool.inputSchema}))}));
      server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        if(!Object.hasOwn(tools,request.params.name))throw new McpError(ErrorCode.InvalidParams,'Tool unavailable');
        running.started=true;
        const signal=AbortSignal.any([extra.signal,disconnected.signal,running.controller.signal]);
        try {
          return await guard.run(request.params.name,(request.params.arguments??{}) as ActionInput,null,{signal}) as CallToolResult;
        }catch(e){
          if(signal.aborted)throw new McpError(ErrorCode.InternalError,'Request cancelled');
          if(e instanceof ActionDenied)return {isError:true,content:[{type:'text',text:`Action denied: ${e.reason}`}]} satisfies CallToolResult;
          return {isError:true,content:[{type:'text',text:'Action failed; outcome may be unknown'}]} satisfies CallToolResult;
        }finally{cleanup();void guard.flush();}
      });
      await server.connect(transport);
      await transport.handleRequest(req,res,body);
    }catch{if(!res.headersSent&&!res.destroyed)respond(res,500,'request_failed');else res.destroy();}
  };
}
