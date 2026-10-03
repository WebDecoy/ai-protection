import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerAIProtection} from '../workers.mjs';
import {fixture} from './fixture.mjs';

test('Worker adapter binds explicit checks and reporting to its request and ctx',async t=>{
  const {options,state}=await fixture(t);const tasks=[];
  const ctx={waitUntil(task){assert.equal(this,ctx);tasks.push(task);}};
  const protect=createWorkerAIProtection(new Request('https://owned.test/chat'),options,ctx);
  const d=await protect.check();assert.equal(d.conclusion,'allow');
  await protect.report(d,{handlerAttempted:true,status:201});await protect.flush();
  assert.equal(tasks.length,1);assert.equal(state.events[0].handler_status,201);
  assert.equal(protect.concurrent,undefined);
});
test('Worker adapter requires execution context and rejects unsupported concurrency',async t=>{
  const {options}=await fixture(t);const request=new Request('https://owned.test/chat');
  assert.throws(()=>createWorkerAIProtection(request,options,null),/execution context/);
  assert.throws(()=>createWorkerAIProtection(request,{...options,concurrency:{}},{waitUntil(){}}),/not supported/);
});
