import {createWorkerAIProtection} from '@webdecoy/ai-protection/workers';

export default {
  async fetch(request, env, ctx) {
    const scenario = new URL(request.url).pathname.slice(1);
    const options = {
      webdecoyUrl:'https://control.test', webdecoyKey:'fixture',
      propertyId:'11111111-1111-4111-8111-111111111111',
      subjectSecret:'x'.repeat(32), scopeId:'workers-test', route:'/chat',
      protectionMode:'enforce', detectorTimeoutMs:100, reportingTimeoutMs:500,
      onObservation:()=>{}, resolveClientIP:()=> '192.0.2.1',
      ...(scenario === 'local' ? {rules:[{id:'plan',mode:'enforce',evaluate:()=>({allowed:false})}]} : {}),
      ...(scenario.startsWith('quota') ? {accountQuota:{ruleId:'chat',limit:1,windowSeconds:60,mode:'enforce',failureMode:'closed',idempotency:true,subject:c=>({accountId:c.id})}} : {}),
    };
    if (scenario === 'cancelled') {
      const controller = new AbortController(); controller.abort();
      request = new Request(request, {signal:controller.signal});
    }
    const protect = createWorkerAIProtection(request, options, ctx);
    try {
      return await protect(() => {
        if (scenario === 'stream') {
          const body = new ReadableStream({async start(controller) {
            controller.enqueue(new TextEncoder().encode('first\n'));
            await new Promise(resolve=>setTimeout(resolve,25));
            controller.enqueue(new TextEncoder().encode('last\n'));controller.close();
          }});
          return new Response(body,{headers:{'X-Fixture':'original'}});
        }
        return new Response('model fixture',{headers:{'X-Fixture':'original'}});
      }, {id:'authenticated-account'});
    } catch(error) {
      if (scenario === 'cancelled') return new Response(error.name, {status:499});
      throw error;
    }
  }
};
