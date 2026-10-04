import type {AIProtectionOptions, ProtectionDecision, ReportOutcome} from './fetch.mjs';
export {createQuotaOperationId} from './fetch.mjs';
/** Structural type; does not require Cloudflare types in Node consumers. */
export interface WorkerExecutionContext {waitUntil(task: Promise<unknown>): void}
export type WorkerAIProtectionOptions<Context = Record<string, unknown>> =
  Omit<AIProtectionOptions<Context>, 'waitUntil' | 'concurrency'>;
export interface WorkerAIProtection<Context> {
  (handler: () => Response | Promise<Response>, context: Context): Promise<Response>;
  check(context: Context): Promise<ProtectionDecision>;
  report(decision: ProtectionDecision, outcome?: ReportOutcome): Promise<void>;
  flush(): Promise<void>;
}
export interface ContextOptionalWorkerProtection extends WorkerAIProtection<Record<string, unknown>> {
  (handler: () => Response | Promise<Response>, context?: Record<string, unknown>): Promise<Response>;
  check(context?: Record<string, unknown>): Promise<ProtectionDecision>;
}
/** Create inside the Worker fetch handler; the returned object belongs to this request only. */
export function createWorkerAIProtection(request: Request, options: WorkerAIProtectionOptions, ctx: WorkerExecutionContext): ContextOptionalWorkerProtection;
export function createWorkerAIProtection<Context>(request: Request, options: WorkerAIProtectionOptions<Context>, ctx: WorkerExecutionContext): WorkerAIProtection<Context>;
