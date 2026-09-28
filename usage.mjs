import {createReporter} from './reporting.mjs';

// Events are constructed internally from bounded numeric fields, never application
// context, prompts, responses, provider errors or credentials.
export function createUsageReporter(options) {
 if(options.reportToWebDecoy!==undefined&&typeof options.reportToWebDecoy!=='boolean')throw Error('Invalid reportToWebDecoy');
 return createReporter({...options,onObservation:async(event,{signal})=>{
  if(options.reportToWebDecoy===false)return;
  const response=await fetch(new URL('/api/v1/sdk/ai-abuse/usage',options.webdecoyUrl),{
   method:'POST',redirect:'error',signal,
   headers:{Authorization:`Bearer ${options.webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':options.propertyId},
   body:JSON.stringify(event)
  });
  await response.body?.cancel();
  if(!response.ok)throw Error('Usage reporting unavailable');
 }});
}
