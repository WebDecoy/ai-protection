import {createAIProtection, type AIProtectionOptions} from '../fetch.mjs';
const base:AIProtectionOptions = {webdecoyUrl:'https://example.test',webdecoyKey:'fixture',propertyId:'fixture',scopeId:'test',subjectSecret:'fixture',resolveClientIP:()=>null};
const simple = createAIProtection(base);
void simple.check(new Request('https://example.test'));
void simple(new Request('https://example.test'),()=>new Response());
const typed = createAIProtection<{plan:'free'|'paid'}>({...base,rules:[{
  id:'plan_policy',evaluate:context=>({allowed:context.plan==='paid'})
}]});
void typed.check(new Request('https://example.test'),{plan:'paid'});
// @ts-expect-error Typed context is mandatory.
void typed.check(new Request('https://example.test'));
// @ts-expect-error Arbitrary client data does not satisfy the declared context shape.
void typed.check(new Request('https://example.test'),{plan:'admin'});
// @ts-expect-error Local rules cannot be asynchronous.
createAIProtection({...base,rules:[{id:'async_rule',evaluate:async()=>({allowed:true})}]});

const accountLimited = createAIProtection<{databaseId: string}>({
  webdecoyUrl:'https://ingest.example.test',webdecoyKey:'server',propertyId:'11111111-1111-4111-8111-111111111111',
  scopeId:'chat',subjectSecret:'x'.repeat(32),resolveClientIP:()=>null,
  accountQuota:{ruleId:'chat_v1',limit:20,windowSeconds:60,mode:'enforce',subject:user=>({accountId:user.databaseId})},
});
const quotaDecision = await accountLimited.check(new Request('https://owned.test/chat'),{databaseId:'server-derived'});
const retryAfter: number | undefined = quotaDecision.retryAfterSeconds;
void retryAfter;

const concurrentProtection = createAIProtection<{databaseId:string}>({
 webdecoyUrl:'https://ingest.example.test',webdecoyKey:'server',propertyId:'11111111-1111-4111-8111-111111111111',scopeId:'chat',subjectSecret:'x'.repeat(32),resolveClientIP:()=>null,
 concurrency:{ruleId:'chat',accountLimit:2,featureLimit:20,subject:user=>({accountId:user.databaseId})},
});
await concurrentProtection.concurrent(new Request('https://owned.test/chat'),({signal})=>{
 signal.throwIfAborted();return {response:new Response('ok'),finished:Promise.resolve()};
},{databaseId:'trusted'});
