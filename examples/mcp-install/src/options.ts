import type {ProtectedMCPOptions} from '@webdecoy/ai-protection/mcp';
export const counters = {reads:0, forbidden:0, waiting:0, cancelled:0};
// Synthetic credentials and records only. Never expose this fixture publicly.
export const mcpOptions: ProtectedMCPOptions = {
 resource:'http://127.0.0.1:8093/mcp', authorizationServer:'https://fixture.example/', policyVersion:'install_fixture_v1',
 authenticate:async request=>{
  const token=request.headers.get('authorization');
  if(token!=='Bearer owned-a'&&token!=='Bearer owned-b')throw Error('Invalid fixture credential');
  return {schema:1,subject:'owned-reader',tenant:token.endsWith('a')?'a':'b',issuer:'fixture',authenticationMethod:'synthetic-session',expiresAt:Date.now()+60000,scopes:['read']};
 },
 tools:{
  read:{description:'Read an owned synthetic record',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},requiredScopes:['read'],
   validate:args=>args!==null&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===1&&typeof (args as {id?:unknown}).id==='string',
   authorize:({caller,args})=>caller.tenant===(args as {id:string}).id,
   execute:({caller,args})=>{if(caller.tenant!==(args as {id:string}).id)throw Error('Ownership changed');counters.reads++;return {content:[{type:'text',text:`owned-${caller.tenant}`}]};}},
  admin:{description:'Forbidden synthetic operation',inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>false,
   execute:()=>{counters.forbidden++;return {content:[]};}},
  wait:{description:'Synthetic cancellable work',inputSchema:{type:'object'},requiredScopes:['read'],validate:()=>true,authorize:()=>true,
   execute:async({signal})=>{if(!signal)throw Error('Cancellation signal required');counters.waiting++;await new Promise<void>((_,reject)=>{const abort=()=>{counters.cancelled++;reject(signal.reason);};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});return {content:[]};}},
 }
};
