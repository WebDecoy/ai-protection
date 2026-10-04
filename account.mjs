import {readJSON,abortable} from './transport.mjs';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const validPropertyID = value => typeof value === 'string' && uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000';

// Short, bounded cache. Never reuse a paid grant after expiry on a failed refresh.
export function createAccountBinding({webdecoyUrl, webdecoyKey, propertyId, detectorTimeoutMs, now = Date.now}) {
  let cached, until = 0, pending;
  return async signal => {
    signal.throwIfAborted();
    if (cached && now() < until) return cached;
    if (pending) return abortable(pending,signal);
    pending = (async () => {
      let next = {status:'unavailable', enforce:false};
      try {
        const response = await fetch(new URL('/api/v1/sdk/ai-abuse/config', webdecoyUrl), {
          headers:{Authorization:`Bearer ${webdecoyKey}`}, redirect:'manual',
          signal:AbortSignal.any([signal, AbortSignal.timeout(detectorTimeoutMs)])
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('account_unavailable'); }
        const value = await readJSON(response);
        if (value.schema !== 1 || !validPropertyID(value.property_id) || !validPropertyID(value.organization_id) ||
            !['observe','enforce'].includes(value.mode) || value.observe !== true || typeof value.enforce !== 'boolean') throw new Error('invalid_account');
        next = value.property_id.toLowerCase() === propertyId.toLowerCase()
          ? {status:'verified', enforce:value.enforce, mode:value.mode, organization_id:value.organization_id, property_id:value.property_id}
          : {status:'property_mismatch', enforce:false};
      } catch { /* Unknown account state keeps chat available in observation. */ }
      cached = next;
      until = now() + (next.status === 'verified' ? 60000 : 5000);
      return next;
    })().finally(() => { pending = undefined; });
    return abortable(pending,signal);
  };
}
