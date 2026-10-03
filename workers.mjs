import {createAIProtection} from './fetch.mjs';
export {createQuotaOperationId} from './quota.mjs';

// Call inside fetch(), once per incoming request. No request-owned I/O or ctx
// escapes into a shared instance, including the core's pending config refresh.
export function createWorkerAIProtection(request, options, ctx) {
  if (!(request instanceof Request)) throw Error('Worker Request required');
  if (!ctx || typeof ctx.waitUntil !== 'function') throw Error('Worker execution context required');
  if (options.concurrency !== undefined) throw Error('Workers concurrency is not supported yet');
  const core = createAIProtection({...options, waitUntil: task => ctx.waitUntil(task)});
  const protect = (handler, context = {}) => core(request, handler, context);
  return Object.assign(protect, {
    check: (context = {}) => core.check(request, context),
    report: core.report,
    flush: core.flush
  });
}
