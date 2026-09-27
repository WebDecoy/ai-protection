import {after} from 'next/server';
import {createAIProtection} from '@webdecoy/ai-protection';
import {streamText, consumeStream, simulateReadableStream} from 'ai';
import {MockLanguageModelV3} from 'ai/test';

export const runtime = 'nodejs';
let protect;
function protection() {
  return protect ??= createAIProtection({
    webdecoyUrl:process.env.WEBDECOY_URL,
    webdecoyKey:process.env.WEBDECOY_KEY,
    propertyId:process.env.WEBDECOY_PROPERTY_ID,
    scopeId:'example-chat', subjectSecret:process.env.WEBDECOY_SUBJECT_SECRET,
    protectionMode:process.env.WEBDECOY_MODE || 'observe',
    waitUntil:task=>after(()=>task),
    // Illustrative customer policy, independent of WebDecoy bot-detection mode.
    rules:[{id:'plan_input_limit', mode:'enforce', evaluate:context=>({
      allowed:context.plan==='paid' || context.inputLength<=4000,
      reason:'plan_input_limit'
    })}],
    // LOCAL FIXTURE ONLY. Production must resolve the actual address from trusted ingress.
    resolveClientIP:()=>process.env.WEBDECOY_LOCAL_FIXTURE === '1' ? '192.0.2.1' : null,
  });
}
export async function POST(request) {
  // Example machine authentication. Browser apps should use their own session + origin checks.
  if (!process.env.EXAMPLE_TOKEN || request.headers.get('authorization') !== `Bearer ${process.env.EXAMPLE_TOKEN}`)
    return Response.json({error:'unauthorized'}, {status:401});
  let body;
  try { body=await request.json(); } catch { return Response.json({error:'invalid_json'},{status:400}); }
  if(typeof body?.prompt !== 'string' || !body.prompt.length || body.prompt.length>8000)
    return Response.json({error:'invalid_prompt'},{status:400});
  return protection()(request,()=>{
    // Deterministic fixture, not a production model or detection-quality test.
    const model=new MockLanguageModelV3({doStream:async()=>({stream:simulateReadableStream({chunks:[
      {type:'text-start',id:'text'},
      {type:'text-delta',id:'text',delta:'Local model response'},
      {type:'text-end',id:'text'},
      {type:'finish',finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:1},outputTokens:{total:3}}}
    ]})})});
    return streamText({model,prompt:body.prompt,abortSignal:request.signal})
      .toUIMessageStreamResponse({consumeSseStream:consumeStream});
  }, {plan:process.env.EXAMPLE_PLAN || 'free', inputLength:body.prompt.length});
}
