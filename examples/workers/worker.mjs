import {createWorkerAIProtection} from '../../workers.mjs';

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/api/chat') return new Response('Not found', {status:404});
    if (request.method !== 'POST') return new Response('Method not allowed', {status:405, headers:{Allow:'POST'}});
    // Local fixture auth. Replace with your application's authentication,
    // origin checks and bounded input validation before invoking a real model.
    if (!env.EXAMPLE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.EXAMPLE_TOKEN}`)
      return new Response('Unauthorized', {status:401});
    const protect = createWorkerAIProtection(request, {
      webdecoyUrl:env.WEBDECOY_URL,
      webdecoyKey:env.WEBDECOY_KEY,
      propertyId:env.WEBDECOY_PROPERTY_ID,
      subjectSecret:env.WEBDECOY_SUBJECT_SECRET,
      scopeId:'workers-chat', route:'/api/chat', protectionMode:'observe',
      // Only trust this on direct Cloudflare ingress. For service/Worker
      // subrequests supply your own resolver under an explicit trust contract.
      resolveClientIP:r => r.headers.get('cf-connecting-ip')
    }, ctx);
    return protect(() => new Response('Protected fixture response; no model is called.', {
      headers:{'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store'}
    }));
  }
};
