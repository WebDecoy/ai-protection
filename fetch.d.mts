export interface AIProtectionOptions {
  webdecoyUrl: string;
  webdecoyKey: string;
  propertyId: string;
  scopeId: string;
  subjectSecret: string;
  /** Return only an address vouched for by your hosting ingress. Null skips detection. */
  resolveClientIP(request: Request): string | null | Promise<string | null>;
  protectionMode?: 'observe' | 'enforce';
  detectorFailureMode?: 'open' | 'closed';
  detectorTimeoutMs?: number;
  baselineLimit?: number;
  baselineWindowMs?: number;
  onObservation?(event: Record<string, unknown>): void;
}
/** Run after authentication, origin checks, input validation and customer quotas. Node >=22. */
export function createAIProtection(options: AIProtectionOptions):
  (request: Request, handler: () => Response | Promise<Response>) => Promise<Response>;
