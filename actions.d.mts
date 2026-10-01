/** Contract supplied by verified server authentication, never parsed from tool arguments. */
export interface TrustedCaller {
  readonly schema: 1;
  readonly subject: string;
  readonly tenant: string;
  readonly issuer: string;
  readonly authenticationMethod: string;
  /** Unix milliseconds; checked again immediately before execution. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  /** OAuth client identity, separate from subject; not an agent signer. */
  readonly clientId?: string;
}
export type ActionInput = null | boolean | number | string | readonly ActionInput[] | {readonly [key:string]: ActionInput};
export interface ActionContext {
  readonly caller: TrustedCaller;
  readonly args: ActionInput;
  readonly signal?: AbortSignal;
}
export interface ActionEvent {
  readonly schema: 1;
  readonly eventId: string;
  readonly timestamp: string;
  readonly checks: readonly {id:string;source:string;mode:string;decision:string;reason:string;durationMs:number}[];
  readonly actionId: string;
  readonly action: string;
  readonly policyVersion: string;
  readonly evaluation: 'local';
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  readonly attempted: boolean;
  readonly outcome: 'not_attempted' | 'attempted' | 'completed' | 'unknown';
}
export interface ActionQuota {ruleId:string;limit:number;windowSeconds:number;mode?:'observe'|'enforce';failureMode?:'open'|'closed';timeoutMs?:number}
export interface ActionLimits {
  callerQuota?: ActionQuota;
  tenantQuota?: ActionQuota;
  concurrency?: {ruleId:string;accountLimit:number;featureLimit:number;mode?:'observe'|'enforce';failureMode?:'open'|'closed';ttlSeconds?:number;maxSeconds?:number;timeoutMs?:number};
}
export interface ActionRuntime {
  webdecoyUrl:string;webdecoyKey:string;propertyId:string;subjectSecret:string;
  reportingTimeoutMs?:number;maxPendingReports?:number;
}
export interface ActionDefinition {
  limits?: ActionLimits;
  requiredScopes: readonly string[];
  validate(args: ActionInput): boolean | Promise<boolean>;
  authorize(context: ActionContext): boolean | Promise<boolean>;
  /** Additional restrictive policy; cannot override application authorization. */
  policy?(context: ActionContext): boolean | Promise<boolean>;
  /** Await all protected work. Do not return a live stream or detached task. */
  execute(context: ActionContext): unknown | Promise<unknown>;
}
export class ActionDenied extends Error {
  readonly reason: string;
  readonly status: number;
  readonly actionId: string;
  readonly retryAfterSeconds?: number;
  constructor(reason: string, status: number, actionId: string);
}
export function createActionProtection<T>(options: {
  policyVersion: string;
  sharedRuntime?: ActionRuntime;
  /** Bounds pre-execution checks only; default 1000 ms, max 10000. */
  admissionTimeoutMs?: number;
  authenticate(context: T, options: {signal?: AbortSignal}): TrustedCaller | Promise<TrustedCaller>;
  actions: Record<string, ActionDefinition>;
  /** Local best-effort observer. sharedRuntime enables independent hosted reporting. */
  onEvent?(event: ActionEvent): void | Promise<void>;
}): {flush():Promise<void>;run(action: string, args: ActionInput, authenticationContext: T, options?: {signal?: AbortSignal}): Promise<unknown>};
