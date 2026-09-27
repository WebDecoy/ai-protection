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
