# Protected MCP tools — unreleased TypeScript integration

A runnable customer-server integration using MCP SDK **1.31.0**, protocol
**2025-11-25**, and the source-only WebDecoy action boundary. No hosted proxy,
WebDecoy API key, model calls, or paid inference is required for the fixture.
The SDK dependencies live in this example, not the core npm package.

## Run the integration tests

From the SDK repository root:

```sh
npm ci --prefix examples/auth0
npm ci --prefix examples/mcp
npm test --prefix examples/mcp
```

Tests use the official MCP client and HTTP transport, generated signing keys and
Auth0-shaped JWTs. They verify actual token signatures and independently count tool
execution. No live identity-provider login is performed.

## Try with your own Auth0 API

Use an RS256 Auth0 custom API whose identifier matches the full `MCP_RESOURCE` URI.
Use your existing authorized token flow; do not use an ID token or a WebDecoy key.

```sh
export AUTH0_ISSUER='https://your-tenant.auth0.com/'
export AUTH0_SUBJECT='your-test-user-subject'
export AUTH0_ORGANIZATION='your-test-organization-id'
export MCP_RESOURCE='http://127.0.0.1:8093/mcp'
npm start --prefix examples/mcp
```

Connect an MCP client with an access token issued for that resource and the
`records:read` scope. `records.read` accepts `{ "id": "record-a" }`.
`records.export` is always denied by application policy, even with export scope.
The environment allowlist is a demonstration; replace it with current application
membership and tenant-scoped database queries. The server binds to loopback.
Use HTTPS for remote deployment and configure the exact external resource URI.
A reverse proxy must preserve the configured Host and trusted origin handling.

The example advertises protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`. Missing/invalid tokens return HTTP 401
with a `WWW-Authenticate` metadata link; missing tool scopes return HTTP 403 with
`insufficient_scope`. Auth0 handles authorization-server discovery and token issuance.
Client registration, login and a live end-to-end OAuth flow remain customer/provider
integration work; this server does not implement an authorization server.

## Integration flow

`src/server.ts` exports `createProtectedMCPHandler`. Supply your original-request
verifier, a fixed resource/issuer, action registry and optional local event sink.

1. Validate Host/Origin and authenticate **every** request.
2. Resolve tenant membership from verified server state.
3. Filter `tools/list` by scope. This is a discovery convenience, not authorization.
4. For `tools/call`, independently validate scopes, arguments, application ownership
   and optional restrictive policy before dispatch.
5. Await the original tool result and preserve the MCP result shape. Emit local
   action evidence without token, arguments, identity or result payloads.

Only explicit allowed origins are accepted when an Origin header is present;
non-browser clients may omit it. Body size is capped at 16 KiB and body reading at
five seconds. Authentication has a one-second deadline; the action boundary has
its separate one-second admission deadline. Your hooks must honor cancellation.
Permission errors never become allowed because cloud detection is unavailable.

## Protocol and lifecycle coverage

- Streamable HTTP POST: initialize, ping, scoped tool discovery and tool calls.
- Responses use the official SDK's SSE stream; tool callbacks must await all work
  and return a complete MCP result. Returning a live model stream is not supported.
- Disconnects cancel the tool signal. MCP cancellation notifications are bound to
  issuer, subject, tenant, OAuth client and request ID; another caller cannot cancel
  the work by guessing its ID.
- At most 128 tool requests are active per handler. Concurrent request-ID reuse for
  the same authenticated caller/client is rejected with 409. Use distinct IDs
  across concurrent connections. This process-local bound is not a distributed quota.
- No session ID or replay/resumption store. GET standalone SSE and DELETE session
  management return 405. Supplied session IDs/Last-Event-ID are rejected. A dropped
  stream cannot be resumed; there is no automatic retry or exactly-once guarantee.
- Resources, prompts, tasks, sampling, elicitation and arbitrary alternate routes
  are not protected by implication; unregistered requests receive SDK errors.
- Cancellation cannot prove that remote side effects stopped. Uncooperative tool
  work holds its active slot until it settles. Re-check ownership in the actual
  database transaction and use provider idempotency for writes.

The wrapper is not yet an exported `/mcp` package entrypoint. Optional `sharedRuntime` enables caller/tenant quotas, concurrency and hosted
action events through the underlying [action configuration](../actions/README.md#shared-limits-and-hosted-evidence-unreleased).
Weighted work reservations and session/resumption support remain follow-ups.
Neither installing npm `0.1.0-alpha.2` nor enabling dashboard enforcement installs
this unreleased integration into a customer server.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
and the [Auth0 verifier example](../auth0/README.md).
