// Owned synthetic records. Replace the bounded data-source functions with queries
// that enforce tenant predicates AND limits in the database/storage operation.
export function createBoundedWorkTools(){
 const counters={searchCalls:0,rows:0,exportCalls:0,bytes:0,adminCalls:0};
 const records={a:['one','two','three','four','five','six'],b:['other-one','other-two','other-three']};
 const emptyObject=args=>args!==null&&typeof args==='object'&&!Array.isArray(args);
 const usage=result=>result._meta['webdecoy.example/workUnits'];
 const tools={
  'documents.search':{
   description:'Search owned synthetic documents (at most five rows)',
   inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:5}},required:['limit'],additionalProperties:false},
   requiredScopes:['documents:read'],validate:args=>emptyObject(args)&&Object.keys(args).length===1&&Number.isInteger(args.limit)&&args.limit>=1&&args.limit<=5,
   authorize:({caller})=>Object.hasOwn(records,caller.tenant),
   limits:{work:{ruleId:'search_work_v1',maxUnits:11,windowSeconds:60,limits:{caller:22,tenant:44,tool:88},mode:'enforce',failureMode:'closed',measure:usage}},
   execute:({caller,args,signal})=>{
    signal.throwIfAborted();counters.searchCalls++;
    // Limit at the data source before doing work or returning a result.
    const rows=records[caller.tenant].slice(0,args.limit);counters.rows+=rows.length;
    return {content:[{type:'text',text:JSON.stringify(rows)}],_meta:{'webdecoy.example/workUnits':1+2*rows.length}};
   },
  },
  'documents.export':{
   description:'Export at most 256 UTF-8 payload bytes from owned synthetic documents',
   inputSchema:{type:'object',properties:{maxBytes:{type:'integer',minimum:1,maximum:256}},required:['maxBytes'],additionalProperties:false},
   requiredScopes:['documents:export'],validate:args=>emptyObject(args)&&Object.keys(args).length===1&&Number.isInteger(args.maxBytes)&&args.maxBytes>=1&&args.maxBytes<=256,
   authorize:({caller})=>Object.hasOwn(records,caller.tenant),
   limits:{work:{ruleId:'export_work_v1',maxUnits:272,windowSeconds:60,limits:{caller:544,tenant:1088,tool:2176},mode:'enforce',failureMode:'closed',measure:usage}},
   execute:({caller,args,signal})=>{
    signal.throwIfAborted();counters.exportCalls++;let text='',bytes=0;
    for(const row of records[caller.tenant]){
     const chunk=row+'\n',size=Buffer.byteLength(chunk);
     if(bytes+size>args.maxBytes)break; // Check before append/write, never truncate after send.
     text+=chunk;bytes+=size;
    }
    counters.bytes+=bytes;
    return {content:[{type:'text',text}],_meta:{'webdecoy.example/workUnits':16+bytes}};
   },
  },
  'documents.admin':{
   description:'Forbidden administrative operation',inputSchema:{type:'object'},requiredScopes:['documents:admin'],validate:()=>true,authorize:()=>false,
   execute:()=>{counters.adminCalls++;throw Error('Forbidden callback');},
  },
 };
 return {tools,counters};
}
