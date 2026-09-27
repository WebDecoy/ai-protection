import { isIP } from 'node:net';
import { createAdmission } from './admission.mjs';

// Node runtime only. Call inside your authenticated, validated route handler.
export function createAIProtection(options) {
  if (typeof options.resolveClientIP !== 'function') throw new Error('resolveClientIP is required');
  const admission = createAdmission(options);
  return async function protect(request, handler) {
    request.signal.throwIfAborted();
    const ip = await options.resolveClientIP(request);
    request.signal.throwIfAborted();
    if (typeof ip !== 'string' || !isIP(ip)) {
      // Never invent an IP or trust a forwarding header implicitly.
      admission.record({event:'webdecoy_admission_skipped', reason:'client_ip_unavailable',
        property_id:options.propertyId, timestamp:new Date().toISOString()});
      return handler();
    }
    const result = await admission.check({ip, method:request.method,
      path:new URL(request.url).pathname,
      headers:Object.fromEntries(request.headers), signal:request.signal});
    const event = {...result.observation, handler_attempted:false};
    try {
      // Detector failures fail open; cancellation must never start inference.
      request.signal.throwIfAborted();
      if (!result.allowed) return Response.json({error:result.error, request_id:event.request_id}, {
        status:result.status, headers:{'Cache-Control':'no-store', 'X-WebDecoy-Request-ID':event.request_id}
      });
      event.handler_attempted = true;
      const response = await handler();
      event.handler_status = response.status;
      return response; // Preserve the original response and streaming body verbatim.
    } catch (error) {
      event.action = request.signal.aborted ? 'cancelled' : 'handler_error';
      throw error;
    } finally {
      // Response creation is not stream completion or proof of a model invocation.
      admission.record(event);
    }
  };
}
