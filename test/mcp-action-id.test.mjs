import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createProtectedMCPHandler} from '../mcp.mjs';
import {createActionProtection} from '../actions.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test('every tool result carries the action ID its reported evidence uses',async t=>{
 const events=[];let handler;
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const resource=`http://127.0.0.1:${server.address().port}/mcp`;
 handler=createProtectedMCPHandler({resource,authorizationServer:'https://issuer.example/',policyVersion:'v1',onEvent:e=>events.push(e),
  authenticate:async()=>({schema:1,subject:'s',tenant:'t',issuer:'fixture',authenticationMethod:'session',scopes:[],expiresAt:Date.now()+60000}),
  tools:{
   read:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>({content:[{type:'text',text:'ok'}],_meta:{'example.com/own':1}})},
   denied:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>false,execute:()=>({content:[]})},
   broken:{inputSchema:{type:'object'},requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>{throw Error('private detail');}},
  }});
 const client=new Client({name:'action-id',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(resource)));
 const ids={};
 for(const name of ['read','denied','broken']){
  const result=await client.callTool({name,arguments:{}});
  ids[name]=result._meta['webdecoy.com/action'].actionId;
  assert.match(ids[name],uuid);
  if(name==='read'){assert.equal(result.content[0].text,'ok');assert.equal(result._meta['example.com/own'],1,'application metadata preserved');}
  if(name==='denied')assert.equal(result._meta['webdecoy.com/action-error'].reason,'permission_denied');
  if(name==='broken')assert.ok(!JSON.stringify(result).includes('private detail'));
 }
 assert.equal(new Set(Object.values(ids)).size,3,'each call has its own action ID');
 for(let i=0;i<50&&events.length<5;i++)await new Promise(r=>setTimeout(r,10));
 // Each returned ID is exactly the one on that call's evidence, and nothing else.
 for(const [name,id] of Object.entries(ids))assert.deepEqual([...new Set(events.filter(e=>e.action===name).map(e=>e.actionId))],[id]);
});

test('onAction receives the ID before checks and cannot change the decision',async()=>{
 const seen=[],events=[];
 const guard=createActionProtection({policyVersion:'v1',authenticate:()=>{throw Error('no session');},onEvent:e=>events.push(e),
  actions:{work:{requiredScopes:[],validate:()=>true,authorize:()=>true,execute:()=>'ran'}}});
 await assert.rejects(guard.run('work',{},null,{onAction:id=>{seen.push(id);throw Error('observer failure');}}),e=>e.reason==='authentication_required');
 await new Promise(r=>setTimeout(r,10));
 assert.equal(seen.length,1);assert.equal(events[0].actionId,seen[0]);
});
