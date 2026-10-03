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
  readonly work?: {readonly maxUnits:number};
  readonly caller: TrustedCaller;
  readonly args: ActionInput;
  readonly signal?: AbortSignal;
}
export interface ActionWorkEvidence {
 readonly rule_id:string;readonly mode:'observe'|'enforce';
 readonly status:'reserved'|'settled'|'unknown'|'unavailable'|'denied'|'replay';
 readonly reserved_units:number;readonly charged_units?:number;readonly remaining_units?:number;
}
export interface ActionWork {
 ruleId:string;windowSeconds:number;maxUnits:number;
 limits:{caller?:number;tenant?:number;tool?:number};
 mode?:'observe'|'enforce';failureMode?:'open'|'closed';timeoutMs?:number;
 /** Trusted server-generated persisted ID. Never use MCP request/session IDs or raw user input. */
 operationId?(context:ActionContext):string;
 /** Confirmed work after completed execution. No async/detached measurement; excess/unknown retains maximum. */
 measure?(result:unknown,context:ActionContext):number;
}
/** Server-supplied metadata, not proof of a verified schema or authorization. */
export interface ToolEffectEvidence {
 readonly schema: 1;
 readonly level: 'unknown' | 'read_only' | 'mutating' | 'destructive';
 readonly reason: 'insufficient_signals' | 'annotation_read_only' | 'name_read_only' | 'annotation_mutating' | 'name_mutating' | 'schema_mutating' | 'annotation_destructive' | 'name_destructive' | 'schema_destructive' | 'conflicting_hints';
}
export interface ToolPermissionEvidence { readonly schema: 1; readonly required_scopes: number; readonly application_authorization: true; readonly additional_policy: boolean; }
export interface ToolSchemaEvidence { readonly decoy?: 'advertised' | 'unadvertised'; readonly permissions?: ToolPermissionEvidence; readonly serverId: string; readonly hash: string; readonly effect?: ToolEffectEvidence; }
export interface ActionEvent {
  readonly toolSchema?: ToolSchemaEvidence;
  /** Pseudonymous application-authenticated subject, not WebDecoy-verified agent identity. */
  readonly caller?: {readonly schema:1;readonly source:'application_auth';readonly id:string};
  readonly work?:ActionWorkEvidence;
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
  tenantConcurrency?: ActionLimits['concurrency'];
  work?:ActionWork;
  callerQuota?: ActionQuota;
  tenantQuota?: ActionQuota;
  concurrency?: {ruleId:string;accountLimit:number;featureLimit:number;mode?:'observe'|'enforce';failureMode?:'open'|'closed';ttlSeconds?:number;maxSeconds?:number;timeoutMs?:number};
}
export interface ActionRuntime {
  /** Opt in to scoped caller pseudonyms in reports. Requires a supporting runtime. Default false. */
  reportCaller?:boolean;
  webdecoyUrl:string;webdecoyKey:string;propertyId:string;subjectSecret:string;
  reportingTimeoutMs?:number;maxPendingReports?:number;
}
export interface ActionDefinition {
  /** Optional non-secret server label and canonical SHA-256 schema hash. MCP discovery fills this automatically.
   * Requires a runtime supporting tool_schema evidence; does not change admission.
   */
  toolSchema?: ToolSchemaEvidence;
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
  /** Bounds local admission checks; shared controls have their own RPC deadlines. Default 1000 ms, max 10000. */
  admissionTimeoutMs?: number;
  authenticate(context: T, options: {signal?: AbortSignal}): TrustedCaller | Promise<TrustedCaller>;
  actions: Record<string, ActionDefinition>;
  /** Local best-effort observer. sharedRuntime enables independent hosted reporting. */
  onEvent?(event: ActionEvent): void | Promise<void>;
}): {flush():Promise<void>;run(action: string, args: ActionInput, authenticationContext: T, options?: {signal?: AbortSignal}): Promise<unknown>};
