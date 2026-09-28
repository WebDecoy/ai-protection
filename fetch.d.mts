export type Mode = 'observe' | 'enforce';
export interface LocalRule<Context> {
  /** Stable non-sensitive code: lowercase letter followed by <=63 letters/digits/underscores. */
  id: string;
  /** Defaults to observe. Independent of cloud mode/availability and dashboard setting. */
  mode?: Mode;
  /** Defaults to closed for an enforced rule error. Does not change detector failure mode. */
  failureMode?: 'open' | 'closed';
  /** Synchronous, deterministic. Use authenticated server state; never a client-supplied identity/plan. */
  evaluate(context: Context): {allowed: boolean; reason?: string; status?: 403 | 429};
}
export interface CheckResult {
  readonly id: string;
  readonly source: 'local' | 'remote' | 'shared';
  readonly mode: Mode;
  readonly decision: 'allow' | 'deny' | 'challenge' | 'unavailable' | 'skipped';
  readonly reason: string;
  readonly durationMs: number;
}
export interface ProtectionDecision {
  readonly id: string;
  readonly conclusion: 'allow' | 'deny';
  readonly reason: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly degraded: boolean;
  readonly checks: readonly CheckResult[];
}
export interface ReportOutcome {
  handlerAttempted?: boolean;
  status?: number;
  cancelled?: boolean;
  handlerError?: boolean;
}
export interface AIProtectionOptions<Context = Record<string, unknown>> {
  webdecoyUrl: string;
  webdecoyKey: string;
  propertyId: string;
  scopeId: string;
  subjectSecret: string;
  /** Return only an address vouched for by hosting ingress. Null skips cloud detection. */
  resolveClientIP(request: Request, runtime: {signal: AbortSignal}): string | null | Promise<string | null>;
  /** Bounds waiting for the trusted resolver; defaults to 1000ms, maximum 10000. */
  clientIPTimeoutMs?: number;
  /** Explicit route template when URL paths contain identifiers. Never derived from browser input. */
  route?: string;
  /** Applies to cloud bot detection only. */
  protectionMode?: Mode;
  /** Opt-in browser tag evidence. Exact first-party HTTPS origin; no API clients require cookies. */
  browserEvidenceOrigin?: string;
  detectorFailureMode?: 'open' | 'closed';
  detectorTimeoutMs?: number;
  baselineLimit?: number;
  baselineWindowMs?: number;
  concurrency?: {
    ruleId: string; subjectSecret?: string; accountLimit: number; featureLimit: number;
    ttlSeconds?: number; maxSeconds?: number; timeoutMs?: number;
    mode?: Mode; failureMode?: 'open' | 'closed';
    subject(context: Context): {accountId: string};
  };
  rules?: readonly LocalRule<Context>[];
  /** Shared admission quota. Configure only from trusted server code. */
  accountQuota?: {
    ruleId: string;
    /** Defaults to the existing subjectSecret. Must match across replicas. */
    subjectSecret?: string;
    limit: number;
    windowSeconds: number;
    /** Optional stricter session cap, always beneath the account cap. */
    sessionLimit?: number;
    mode?: Mode;
    /** Defaults to open; closed is an explicit availability tradeoff. */
    failureMode?: 'open' | 'closed';
    timeoutMs?: number;
    subject(context: Context): {accountId: string; sessionId?: string};
  };
  /** Async best-effort sink. Context/body/raw exceptions are never included by the SDK. */
  onObservation?(event: Record<string, unknown>, options: {signal: AbortSignal}): void | Promise<void>;
  /** Use hosting waitUntil or Next.js after(() => task) inside a request scope. */
  waitUntil?(task: Promise<void>): void;
  /** Send bounded decision/outcome metadata to WebDecoy. Defaults to true; independent of the local sink. */
  reportToWebDecoy?: boolean;
  reportingTimeoutMs?: number;
  maxPendingReports?: number;
}
export interface AIProtection<Context> {
  (request: Request, handler: () => Response | Promise<Response>, context: Context): Promise<Response>;
  concurrent(request: Request, handler: (runtime: {signal: AbortSignal}) =>
    {response: Response; finished: Promise<void>} | Promise<{response: Response; finished: Promise<void>}>, context: Context): Promise<Response>;
  check(request: Request, context: Context): Promise<ProtectionDecision>;
  report(decision: ProtectionDecision, outcome?: ReportOutcome): Promise<void>;
  /** Wait for currently pending reports, bounded by each report's timeout. */
  flush(): Promise<void>;
}
/** Existing two-argument usage remains valid when no typed context is required. */
export interface ContextOptionalProtection extends AIProtection<Record<string, unknown>> {
  (request: Request, handler: () => Response | Promise<Response>, context?: Record<string, unknown>): Promise<Response>;
  check(request: Request, context?: Record<string, unknown>): Promise<ProtectionDecision>;
}
export function createAIProtection(options: AIProtectionOptions): ContextOptionalProtection;
export function createAIProtection<Context>(options: AIProtectionOptions<Context>): AIProtection<Context>;

/** All monetary values use integer micro-USD. Zero limits disable that scope/unit. */
export interface BudgetLimits {
 account_tokens?: number; account_micros?: number;
 tenant_tokens?: number; tenant_micros?: number;
 feature_tokens?: number; feature_micros?: number;
}
export interface BudgetPrice {
 provider: string; model: string;
 inputMicrosPerMillion: number; outputMicrosPerMillion: number;
}
export interface BudgetUsage {provider:string; model:string; inputTokens:number; outputTokens:number}
export interface BudgetOutcome {reason:string; overrun:boolean; reserved:boolean; wouldDeny:boolean}
export interface BudgetOptions<T> {
 webdecoyUrl:string; webdecoyKey:string; propertyId:string; ruleId:string;
 subjectSecret:string; windowSeconds:number; limits:BudgetLimits;
 mode?:Mode; failureMode?:'open'|'closed'; timeoutMs?:number; maxRuntimeMs?:number;
 reportToWebDecoy?:boolean; waitUntil?:(task:Promise<void>)=>void; reportingTimeoutMs?:number; maxPendingReports?:number;
 prices:Record<string,BudgetPrice>;
 subject(context:T):{accountId:string; organizationId:string};
}
export interface BudgetCall {requestId?:string; priceId:string; maxInputTokens:number; maxOutputTokens:number}
export class BudgetDenied extends Error {status:number;retryAfterSeconds:number}
export function budgetCost(price:BudgetPrice,inputTokens:number,outputTokens:number):number;
export function ollamaBudgetUsage(final:unknown):BudgetUsage|null;
export function createAIBudget<T>(options:BudgetOptions<T>):{
 flush():Promise<void>;
 run<V>(context:T,call:BudgetCall,work:(runtime:{provider:string;model:string;maxInputTokens:number;maxOutputTokens:number;signal:AbortSignal})=>{value:V;finished:Promise<BudgetUsage|null>}|Promise<{value:V;finished:Promise<BudgetUsage|null>}>,signal?:AbortSignal):Promise<{value:V;accounting:Promise<BudgetOutcome>;callId:string}>;
};
