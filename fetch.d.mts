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
  resolveClientIP(request: Request): string | null | Promise<string | null>;
  /** Applies to cloud bot detection only. */
  protectionMode?: Mode;
  detectorFailureMode?: 'open' | 'closed';
  detectorTimeoutMs?: number;
  baselineLimit?: number;
  baselineWindowMs?: number;
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
