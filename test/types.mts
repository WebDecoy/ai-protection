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

import {createAIBudget,ollamaBudgetUsage} from '../fetch.mjs';
const budget = createAIBudget<{id:string;org:string}>({webdecoyUrl:'https://example.test',webdecoyKey:'server',propertyId:'11111111-1111-4111-8111-111111111111',ruleId:'chat',subjectSecret:'x'.repeat(32),windowSeconds:60,limits:{account_tokens:1000},prices:{local:{provider:'ollama',model:'fixture',inputMicrosPerMillion:0,outputMicrosPerMillion:0}},subject:u=>({accountId:u.id,organizationId:u.org})});
const budgetRun=await budget.run({id:'a',org:'o'},{priceId:'local',maxInputTokens:10,maxOutputTokens:20},runtime=>({value:new Response(runtime.model),finished:Promise.resolve(ollamaBudgetUsage({done:true,model:'fixture',prompt_eval_count:10,eval_count:3}))}));
const response:Response=budgetRun.value;
void response;void budgetRun.accounting;

// Local action boundary: trusted authentication context is supplied by server code.
import {createActionProtection, type TrustedCaller} from '../actions.mjs';
const actionCaller: TrustedCaller = {schema:1, subject:'u', tenant:'t', issuer:'session',
  authenticationMethod:'session', expiresAt:Date.now()+60000, scopes:['read']};
const actions = createActionProtection({policyVersion:'v1',authenticate:(_session:string)=>actionCaller,
  actions:{read:{requiredScopes:['read'],validate:()=>true,authorize:({caller})=>caller.tenant==='t',
    execute:({signal})=>signal?.aborted??false}}});
void actions.run('read',{id:'r'},'server-session');
// @ts-expect-error Authentication context must match the server verifier.
void actions.run('read',{},123);
