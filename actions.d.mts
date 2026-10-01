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
  readonly actionId: string;
  readonly action: string;
  readonly policyVersion: string;
  readonly evaluation: 'local';
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  readonly attempted: boolean;
  readonly outcome: 'not_attempted' | 'attempted' | 'completed' | 'unknown';
}
export interface ActionDefinition {
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
  constructor(reason: string, status: number, actionId: string);
}
export function createActionProtection<T>(options: {
  policyVersion: string;
  /** Bounds pre-execution checks only; default 1000 ms, max 10000. */
  admissionTimeoutMs?: number;
  authenticate(context: T, options: {signal?: AbortSignal}): TrustedCaller | Promise<TrustedCaller>;
  actions: Record<string, ActionDefinition>;
  /** Local best-effort observer. No hosted action reporting in this preview. */
  onEvent?(event: ActionEvent): void | Promise<void>;
}): {run(action: string, args: ActionInput, authenticationContext: T, options?: {signal?: AbortSignal}): Promise<unknown>};
