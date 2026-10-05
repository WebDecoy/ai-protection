# Reviewable MCP setup (source preview)

This command scaffolds a handler for a selected Node TypeScript ESM options module.
It is available from this SDK source checkout, not an npm binary. It does not
install dependencies, rewrite an existing server, run project code or prove a live
integration. Next.js, Go, stateful MCP and automatic framework detection are not
supported by this command.

Prepare an existing options module that exports `mcpOptions` typed as
`ProtectedMCPOptions` from `@webdecoy/ai-protection/mcp`. Use the [MCP integration
contract](../../MCP.md): resource URL ending in `/mcp`, trusted authentication,
explicit tool validation and authorization, and customer-owned tool callbacks.
Configure shared controls and secrets in your server environment as needed.

From this SDK source checkout:

```sh
node scripts/setup-mcp.mjs plan /absolute/path/to/app src/mcp-options.ts
node scripts/setup-mcp.mjs apply /absolute/path/to/app src/mcp-options.ts
node scripts/setup-mcp.mjs rollback /absolute/path/to/app src/mcp-options.ts
```

`plan` reads bounded package/source files and prints a proposed addition plus
metadata checks. Review it first. `apply` requires exact tested dependency pins
(`@webdecoy/ai-protection@0.1.0-alpha.17`, MCP SDK `1.31.0`) and `type: module`.
Other dependency ranges are unverified, not automatically upgraded. It creates
`webdecoy-mcp.ts` beside the selected module using exclusive creation. Repeating
apply is a no-op when the contents match; an existing different file is untouched.
Rollback removes only a byte-identical generated file; it refuses edited content.
These commands operate on a project at rest; do not concurrently edit or rename
its directories during an apply/rollback operation.

Compile with your own build, then connect the exported `protectedMCPHandler` only
to the intended `/mcp` route. The command cannot verify the selected module's
export or route wiring by reading package metadata. It creates no listening server
and does not remove alternate handlers. Remove your manual route wiring before
rollback. Broad installation, runtime diagnostics and route edits remain #1408.

## Interpretation of results

`configured` means only that package metadata matches the tested versions.
`coverage: not_verified` is intentional. Authentication, ownership, credentials,
backend compatibility, effective modes, report delivery, request correlation and
callback behavior remain unverified. Browser receipts are not required for machine
callers; model budget reporting is not verified by a tools-only scaffold.

No secrets or source contents are printed. Follow the remediation fields, compile,
and run an owned synthetic workload before claiming protection. The app repository's
MCP/PostgreSQL acceptance and this example's official-client tests demonstrate
supported behavior in fixtures; they do not validate your deployment automatically.

## Read-only property/runtime diagnostic

From the source checkout, provide `WEBDECOY_KEY` and `WEBDECOY_PROPERTY_ID` through
your server environment or secret manager, then run:

```sh
node scripts/diagnose-mcp.mjs
```

`WEBDECOY_URL` optionally overrides the default
`https://ai-protection.webdecoy.com` origin. HTTPS is required except on loopback.
Do not pass a key as a command-line argument. The command sends one authenticated
GET to `/api/v1/sdk/ai-abuse/config`, with a two-second deadline, no redirect
following, no retry and a 16 KiB response limit. It never calls tools, sends model
requests, reserves quota, submits reports or changes configuration.

Exit 0 means only that the schema-1 config endpoint accepted the credentials and
returned the selected property. Exit 1 includes a bounded diagnostic reason and
remediation. Keys, response bodies and other properties' identifiers are never
printed. The chosen runtime origin receives the key, so use your trusted gateway.

`configuredPropertyMode` is the server's property configuration, and
`cloudEnforcementEntitled` is an entitlement. Neither establishes effective
per-tool mode or failure policy: those also depend on the local application
options. `effectiveToolControls` and route `coverage` remain `not_verified`.
Credential success does not establish caller authentication, permission checks,
model/request correlation, budget settlement or evidence delivery.

## Verify a selected local route

After wiring and starting your owned local server, provide `MCP_RESOURCE` (for
example `http://127.0.0.1:8093/mcp`) and `MCP_TEST_TOKEN` through the environment:

```sh
node scripts/verify-mcp-route.mjs
```

This source-only probe accepts numeric HTTP loopback addresses and the exact
`/mcp` path. The server's configured resource URL must match. It first sends
unauthenticated and intentionally invalid-credential pings; both must return 401.
It checks resource metadata on the same origin, then uses the official pinned MCP
client to initialize, ping and list tools with the supplied credential. It does
not follow redirects or discovery URLs to other servers. Responses are bounded
at 64 KiB with a two-second per-request deadline. Tokens, tool names and response
bodies are not printed.

Exit 0 verifies only that selected local protocol/authentication boundary. The
report lists unverified controls explicitly. No `tools/call` requests are sent;
there is no inference/provider fallback. Listing tools can emit discovery reports
if your server enables that feature. As with any request, application middleware
may perform its own work; the probe does not sandbox the server.

This cannot establish zero side effects in an arbitrary application from network
responses alone. Independent callback counters and permitted/forbidden/cross-tenant
synthetic tool fixtures are still required for action-enforcement acceptance.

## Wire an explicitly marked Node route

The separate source command below edits only two opt-in markers. This preview
supports an LF TypeScript Node ESM module with a request callback whose parameters
are named `req` and `res`. It does not detect arbitrary frameworks or migrate
existing MCP server registrations. Place these exact unindented marker lines at
module scope and inside the request callback before any competing MCP handler:

```ts
// WEBDECOY:MCP_IMPORT
// ... your other imports and application initialization ...
export function route(req: IncomingMessage, res: ServerResponse) {
// WEBDECOY:MCP_ROUTE
  // Existing non-MCP routing continues here.
}
```

After creating the generated handler, review and apply:

```sh
node scripts/wire-mcp-route.mjs plan /absolute/path/to/app src/server.ts src/webdecoy-mcp.ts
node scripts/wire-mcp-route.mjs apply /absolute/path/to/app src/server.ts src/webdecoy-mcp.ts
node scripts/wire-mcp-route.mjs rollback /absolute/path/to/app src/server.ts src/webdecoy-mcp.ts
```

The plan prints only the marker replacements, not surrounding source or secrets.
Apply adds the handler import and dispatches `/mcp` plus its protected-resource
metadata path. Other paths continue through the original code. The command does
not start a listener or remove earlier competing routes; review placement yourself.
Compile, start the server and use the local route verifier afterward.

Repeated apply is unchanged. Rollback restores the empty markers while retaining
edits outside the generated blocks. Edits inside either generated block, duplicated
markers, symlink paths, outside-project files and unsupported line endings are
refused. Changes use a same-directory temporary file and atomic rename, after
checking the original content again. Operate on a project at rest; this does not
lock out concurrent editors. Roll back route wiring before removing the handler.

Successful wiring still reports `coverage: not_verified`. It does not establish
correct marker placement, authentication, per-tool permissions or shared controls.

## Inspect configured and observed controls

From the source checkout, import `inspectMCPControls` and `collectMCPDiagnostics`
from `scripts/inspect-mcp-controls.mjs` into an owned server verification harness:

```js
const diagnostics = collectMCPDiagnostics();
const inspected = inspectMCPControls(mcpOptions);
// Compose these with any existing application observers.
mcpOptions.onEvent = diagnostics.onEvent;
if (mcpOptions.sharedRuntime) {
  mcpOptions.sharedRuntime.onReport = diagnostics.onReport;
}
console.log(JSON.stringify(inspected));
// After explicitly selected synthetic calls finish:
console.log(JSON.stringify(diagnostics.snapshot()));
```

Inspection runs actual adapter startup validation without invoking authentication,
validation, authorization or tool callbacks and without network requests. It shows
which controls are unconfigured, the actual observe/enforce and open/closed defaults,
timeouts and how configured exhaustion/unavailability is handled. Rule IDs, scope
names, credentials, subject secrets, schemas and resource URLs are omitted.

The bounded collector retains at most 1,000 events and 1,000 reporting receipts.
It shows observed action phases and control checks, correlating receipts by event
and action ID. `accepted` means the reporting HTTP endpoint returned success;
it does not prove database retention or visibility in the dashboard. Failed
requests are `unavailable`. Absent receipts remain `missingOrPending`: dropped
queues, hung observers or shutdown may prevent evidence. Collector drops are explicit.

`onReport` requires Node alpha.17 or later. It is best effort, limited to 100 pending
local observer calls, with no effect on tool results or reporting retries. The
receipt contains only schema, event ID, action ID and accepted/unavailable status.
Model correlation, model-budget settlement and alternate handlers remain unverified
by tool-action observations. Browser receipts are unsupported by this MCP adapter.
