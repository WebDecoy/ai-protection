// Explicit wire schema. Never serialize the full observation or application context.
export function createTelemetry({webdecoyUrl, webdecoyKey, propertyId, reportToWebDecoy = true}) {
  if (typeof reportToWebDecoy !== 'boolean') throw new Error('Invalid reportToWebDecoy');
  return async (event, {signal}) => {
    if (!reportToWebDecoy) return;
    const payload = {schema:1, request_id:event.request_id, timestamp:event.timestamp,
      decision:event.decision, reason:event.reason, degraded:event.degraded,
      checks:event.checks.map(check => ({id:check.id,source:check.source,mode:check.mode,
        decision:check.decision,reason:check.reason,duration_ms:check.durationMs})),
      handler_attempted:event.handler_attempted,
      ...(event.handler_status !== undefined ? {handler_status:event.handler_status} : {}),
      action:event.action};
    const response = await fetch(new URL('/api/v1/sdk/ai-abuse/reports',webdecoyUrl),{
      method:'POST',redirect:'manual',signal,
      headers:{Authorization:`Bearer ${webdecoyKey}`,'Content-Type':'application/json','X-WebDecoy-Property-ID':propertyId},
      body:JSON.stringify(payload)
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('WebDecoy reporting unavailable');
  };
}
