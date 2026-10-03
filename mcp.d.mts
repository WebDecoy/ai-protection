/// <reference types="node" />
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import type {ActionContext, ActionDefinition, ActionEvent, ActionRuntime, TrustedCaller} from './actions.mjs';

/** Explicitly registered tool; inputSchema describes discovery, validate enforces input. */
export interface ProtectedTool extends Omit<ActionDefinition, 'toolSchema'> {
  description: string;
  inputSchema: Tool['inputSchema'];
  /** Behavioral hints, never authorization or verified guarantees. */
  annotations?: Pick<NonNullable<Tool['annotations']>, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>;
  /** Await all protected work and return a complete MCP result, never a detached stream. */
  execute(context: ActionContext): CallToolResult | Promise<CallToolResult>;
}

export interface ProtectedMCPOptions {
  /** Exact external /mcp URL. HTTPS required except on loopback. */
  resource: string;
  /** HTTPS issuer URL used in protected-resource metadata. */
  authorizationServer: string;
  /** Verify each request's credential and resolve membership from trusted application state. */
  authenticate(request: Request, options: {signal: AbortSignal}): Promise<TrustedCaller>;
  policyVersion: string;
  sharedRuntime?: ActionRuntime;
  tools: Record<string, ProtectedTool>;
  /** Opt-in, at most eight named decoys. Requires discovery + sharedRuntime.
   * Never accepts customer execution callbacks. Combined real/decoy registry <=128.
   */
  decoys?: Record<string, {description: string; visibility: 'advertised' | 'unadvertised'}>;
  /** Opt-in tools/list and tools/call metadata: stable non-secret server label and SHA-256 input-schema hashes.
   * Requires sharedRuntime. Reuse serverId across replicas; separate different servers.
   */
  discovery?: { serverId: string };
  /** Exact browser origins; requests without Origin are permitted after authentication. */
  allowedOrigins?: string[];
  /** Best-effort, sanitized action events. */
  onEvent?(event: ActionEvent): void | Promise<void>;
}

/**
 * Stateless Node HTTP handler for a closed MCP tool registry.
 * Requires the optional @modelcontextprotocol/sdk peer (tested/pinned 1.31.0).
 * Does not wrap existing MCP servers, resources, prompts, tasks or alternate routes.
 */
export function createProtectedMCPHandler(options: ProtectedMCPOptions):
  ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
    /** Drain pending discovery reports at shutdown. Does not wait for running tools. */
    flush(): Promise<void>;
  };
