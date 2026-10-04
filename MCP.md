# MCP tool protection (Alpha)

`@webdecoy/ai-protection/mcp` is a Node HTTP handler for a closed registry of
protected tools. It runs in your application's backend. Your MCP traffic stays
on your server; configured shared limits and sanitized action reports use the
WebDecoy runtime. Your application owns authentication, tenant membership and
resource authorization.

## Install

Available in `0.1.0-alpha.5` and later compatible alpha releases:

```sh
npm install @webdecoy/ai-protection@0.1.0-alpha.11 @modelcontextprotocol/sdk@1.31.0
```

Requires Node 22.22.3+ and MCP SDK **1.31.0**. The MCP SDK is an optional peer, so
ordinary request/action SDK installs do not install it. Only `/mcp` imports it.
TypeScript Node applications also need their usual `@types/node` development
dependency. Tests exercise MCP protocol **2025-11-25** with the official client.

## Connect your application

```ts
import {createServer} from 'node:http';
import {createProtectedMCPHandler} from '@webdecoy/ai-protection/mcp';
import {verifyAccessToken, records} from './your-application.js';

const handler = createProtectedMCPHandler({
  resource: 'https://api.example.com/mcp',
  authorizationServer: 'https://your-issuer.example.com/',
  policyVersion: 'records_v1',
  // Your verifier validates issuer, audience/resource, signature and expiry,
  // then resolves tenant membership from trusted application state.
  authenticate: (request, {signal}) => verifyAccessToken(request, {signal}),
  tools: {
    'records.read': {
      description: 'Read an owned record',
      inputSchema: {
        type: 'object', properties: {id: {type: 'string'}},
        required: ['id'], additionalProperties: false,
      },
      requiredScopes: ['records:read'],
      validate: args => args !== null && typeof args === 'object'
        && !Array.isArray(args) && Object.keys(args).length === 1
        && 'id' in args && typeof args.id === 'string',
      authorize: ({caller, args}) => records.canRead(caller, args),
      // The database query must scope by the trusted tenant, even after authorize.
      // Await all work; return a complete MCP result, not a detached stream/task.
      execute: ({caller, args, signal}) => records.readForTenant(caller.tenant, args, signal),
    },
  },
});
const server = createServer((req, res) => { void handler(req, res); });
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(8093, '127.0.0.1'); // Put your existing HTTPS proxy in front.
```

The application imports above are integration hooks, not exports from this SDK.
See the [runnable Auth0-backed example](examples/mcp/README.md) for a concrete
verifier and test registry. The verifier returns the [trusted caller contract](actions.d.mts):
schema, subject, tenant, issuer, authentication method, expiry and scopes. Never
derive tenant or permissions from tool arguments, a session ID, agent name or a
WebDecoy API key. A separate WebDecoy-owned Auth0 account is not required.

`inputSchema` advertises the tool shape; the application `validate` hook enforces
it before dispatch. Tool listing is filtered by scopes, while every tool call
independently checks scopes, validation and application permissions. Do not expose
the same operation through an unguarded alternate handler.

## Shared controls and evidence

Supply `sharedRuntime` with the server-only WebDecoy URL, API key, property ID and
stable subject secret. Add `limits.callerQuota`, `limits.tenantQuota` and/or
`limits.concurrency` to each protected tool. These use the same configuration as
the [action API](examples/actions/README.md#shared-limits-and-hosted-evidence).
Limits follow verified identities, not MCP connection/session identifiers.

Authentication and explicit permission denials always stop dispatch. Shared-state
failure follows each limit's configured `failureMode`; use enforce/closed for a
hard admission limit. Observe/open does not establish a hard ceiling. This adapter
does not itself run request bot detection or a prompt scanner. If you add detector
checks elsewhere, keep their default fail-open behavior separate from permissions.

Optional `onEvent` receives sanitized action outcomes. Shared-runtime reporting is
best effort. Events omit tokens, raw identities, tool arguments and result content.
A completed event means the callback resolved; independently check your own
database/provider for side-effect confirmation. A failed/disconnected call may
have unknown work. Never retry writes without application/provider idempotency.

## Supported boundary

- Stateless Streamable HTTP at `/mcp`: initialize, ping, scoped `tools/list`,
  protected `tools/call`, and caller-bound cancellation notifications.
- Protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`;
  missing/invalid credentials get HTTP 401, missing scopes get HTTP 403 challenges.
  Permission/limit denials after admission use MCP tool errors with bounded retry
  guidance in `_meta["webdecoy.com/action-error"]`.
- Host must match `resource`; present Origin headers must be explicitly allowed.
  Non-browser clients can omit Origin. Preserve Host through your trusted proxy.
- At most 16 KiB per JSON message, five-second body read, one-second authentication
  deadline and at most 128 active tool calls per handler. These local bounds are
  distinct from shared caller quotas.
- SSE carries the final MCP response. Tools must await completion; arbitrary live
  tool-result streams are unsupported. A disconnect requests cooperative abort;
  explicit cancellation is scoped to the authenticated caller/client/request ID.
  Uncooperative work retains its local active slot until it settles.
- No session store, replay/resumption, automatic retry or exactly-once execution.
  Supplied session/replay IDs are rejected; standalone SSE GET and DELETE return
  405. Reconnects do not grant fresh identity allowances.
- Resources, prompts, tasks, sampling, elicitation, other routes and pre-existing
  MCP handlers are not wrapped. Unregistered methods/tools do not dispatch.
  Weighted tool work is available in the alpha API; see [bounded work](WORK.md)
  for its runtime prerequisite and application-enforced bounds. Full product
  acceptance remains separate from this adapter's tested contract.

This is an explicit tools integration, not transparent protection of an existing
whole MCP server. See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

For weighted search/export limits and tenant concurrency, see [bounded tool work](WORK.md).


## Opt-in tool discovery (alpha.7+)

Add these options alongside your existing `tools` and authentication configuration:

```ts
sharedRuntime: {
  webdecoyUrl: 'https://ai-protection.webdecoy.com',
  webdecoyKey: process.env.WEBDECOY_API_KEY!,
  propertyId: process.env.WEBDECOY_PROPERTY_ID!,
  subjectSecret: process.env.WEBDECOY_SUBJECT_SECRET!, // at least 32 bytes
},
discovery: { serverId: 'records-api' },
```

Use a stable, non-secret server label (1–96 letters, digits, `_`, `.`, `:`, `-`,
starting with a letter or digit). Reuse it across replicas/releases of the same
logical server. Give separate servers separate labels within a property. Do not
include tenant IDs, hostnames containing secrets, or customer information.

An authenticated MCP client calls `tools/list`. Each nonempty response queues a
best-effort advertisement of the visible tool names and SHA-256 input-schema
hashes. The AI Protection dashboard shows **MCP tool inventory**, including
tools that have never executed. This does not scan unwrapped servers, hidden tools,
resources, prompts or alternate routes. No network request is made at handler
construction. Discovery is off unless configured and requires sharedRuntime.

Hashes cover the JSON input schema with recursively sorted object keys; array
order is preserved. Raw schemas, descriptions, arguments, results, credentials,
caller identities and required scopes are not uploaded. A schema hash is a
fingerprint, not encryption; someone with a candidate schema can compare it.
Multiple hashes for one server/tool show reported variants in the seven-day
receipt window. Rolling deployments and benign schema edits can cause variants.
They do not establish an attack, breaking change, removal or missing permission.
The UI uses the latest receipt's hash, not a claim about deployment order.

Discovery uses schema-3 reports on the existing reporting endpoint; deploy a
compatible hosted runtime first. Old runtimes reject these optional reports
without affecting tool listing. Reporting has bounded pending work and a deadline,
never blocks authorization, and does not retry. Call `await handler.flush()` at a
host shutdown/lifecycle boundary to drain pending discovery reports; it does not
wait for active tool calls or action reports. Abruptly terminated hosts can lose
reports. Discovery advertisements never increment tool action or request counts.


### Calls before discovery (alpha.8+)

With `discovery` enabled, the adapter also attaches the registered server label
and schema fingerprint to each `tools/call` action report. This includes local
permission/scope denials for registered tools. It works before a client calls
`tools/list`; no listing round trip is required to execute an authorized tool.
Unknown tool names and requests rejected before authentication do not gain
registry metadata. Turning discovery off omits the new call metadata too.

The inventory combines advertisements and action evidence by property, server
label and tool name. Attempt/start/completion reports sharing an action ID count
once. Counts include denied attempts, so they are not successful-execution totals.
“Call evidence only” means no advertisement was captured in the bounded seven-day
sample. Clients can call directly; hidden scopes, sampling and missing telemetry
also limit coverage. This is not an attack or permission-gap verdict. Older action
reports without metadata still appear in the general activity table, aggregated
by tool name across servers; their server/schema association remains unknown.

Deploy a runtime accepting optional `tool_action.tool_schema` before upgrading an
integration with discovery enabled. Older runtimes reject affected action reports
without changing admission. The action API also supports optional `toolSchema:
{serverId, hash}` on trusted registered definitions; it is snapshotted and validated,
never read from tool arguments. This is SDK-reported metadata, not authorization
or independent verification of a schema.


### Advisory side effects (alpha.9+)

With discovery enabled, the SDK adds a fixed classification and reason code to
catalog/call metadata: `unknown`, `read_only`, `mutating`, or `destructive`.
This is heuristic inference, not a prompt scanner, authorization policy, verified
behavior or proof that side effects occurred. Classification never allows or
blocks a request. Existing validate/authorize/scopes/limits still control dispatch.

You may supply MCP boolean hints on a protected tool:

```ts
annotations: { readOnlyHint: true, destructiveHint: false },
```

Supported annotations are readOnlyHint, destructiveHint, idempotentHint and
openWorldHint. The adapter snapshots those booleans and includes them in scoped
MCP listing responses. Only classification codes enter WebDecoy reports; raw
annotations, schemas and descriptions are not uploaded. The schema fingerprint
continues to cover inputSchema, not annotations or implementation code.

The classifier checks tokenized tool names and explicit top-level `action`,
`operation` or `method` selectors (`const`/up to 64 enum values). It does not
resolve schema references, scan arbitrary text/arguments, execute tools, or call a
model. Destructive/mutating signals take precedence over a contradictory read-only
hint and are labeled conflicting. With no useful signals it reports unknown.
Name heuristics can be wrong (for example, a status tool named after deletion).
As the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
requires, annotations must not be treated as guarantees from an untrusted server.

The dashboard shows inferred evidence separately from a customer classification.
Use **Review classification** to select a label or return to SDK inference.
Overrides are property/server/tool settings bound to the current input-schema
hash; a different hash falls back to inference and prompts review. Changes to
annotations or implementation without a schema change do not invalidate an
override, so review those changes yourself. A saved classification changes only
the dashboard label; it is not read by runtime enforcement. Overrides persist as
customer settings until reset or property deletion; SDK evidence retains its
seven-day window. Where evidence disagrees for the latest received schema, the
review order is destructive, mutating, unknown, then read-only. Older SDKs without
classification metadata remain unknown, though customers can label their tools.

Requires a runtime accepting optional `effect` evidence. Deploy it before
upgrading a discovery-enabled integration. Large registries are split into
bounded catalog batches so added metadata stays within report body limits.

## Reviewing tool permissions

Discovery reports configuration evidence for each registered tool: the number of
`requiredScopes`, the presence of the mandatory `authorize` callback, and whether
an additional `policy` callback is configured. It never reports scope names or
callback code. These are SDK-reported settings, not verified authorization quality.
This metadata starts in Node alpha.10. Deploy a compatible runtime before upgrading.

The inventory asks you to review a potentially mutating/destructive tool with no
required scopes. This does **not** mean it is unprotected: application authorization
may already provide sufficient protection. Review the named server/tool in your
registry and check the application's tenant/resource ownership checks. Where your
OAuth model uses per-tool scopes, configure them on that tool, for example:

```js
requiredScopes: ['records:write'],
authorize: ({caller, args, signal}) =>
  canModifyRecord(caller.tenant, caller.subject, args.id, {signal}),
```

`canModifyRecord` is your application's authorization function. Preserve ownership
checks at the database transaction that performs the write. After deploying, make
an authenticated tools/list or tools/call request and refresh the inventory.
The dashboard cannot edit or inspect your application callback. An additional
policy cannot override a deny from application authorization.

Older/missing evidence remains unknown. Conflicting reported configurations for
the selected input-schema hash remain conflicting. The seven-day bounded sample
can include both sides of a rolling deployment; it does not certify the latest
running configuration or prove that unwrapped routes are protected. A changed
scope or callback does not change the input-schema hash. No enforcement behavior
changes when discovery is enabled.

## Explicit decoy tools (Alpha)

Decoys are off by default. Node alpha.11 supports up to eight explicitly named
synthetic tools in the protected registry; requires `discovery` and `sharedRuntime`.
The combined real/decoy registry still has a 128-tool limit. Deploy a compatible
runtime before upgrading an integration that enables decoys.

```js
discovery: {serverId: 'billing'},
decoys: {
  billing_export_ledger: {
    description: 'Internal ledger export',
    visibility: 'advertised',
  },
  admin_rotate_keys: {
    description: 'Internal key rotation',
    visibility: 'unadvertised',
  },
},
```

Choose names and descriptions outside legitimate workflows; examples are not a
recommended universal decoy set. Collisions with real tools, callback fields and
invalid definitions fail startup. Definitions are snapshotted. The SDK provides a
generic object schema; no custom execution, validation or authorization callbacks
are accepted for decoys. Advertised decoys appear to authenticated listing clients;
unadvertised decoys never appear in tools/list. Both accept direct authenticated
calls only to return the ordinary permission-denied error. Customer code is never
executed, including when shared telemetry is unavailable. Real tools retain their
normal authorization and behavior.

Only reported calls count as decoy calls; listing is not a trip. Discovery and
call reports carry a fixed decoy visibility marker, not arguments, hashes of
arguments, descriptions or generated identities. Existing opt-in caller attribution
can associate calls with application-reported pseudonyms. Invalid unauthenticated
requests, over-limit transport bodies and unwrapped routes are not covered by this
trip evidence. Delivery remains best effort. A marker is SDK-reported evidence,
not independently verified server configuration.

The dashboard labels decoys and mixed real/decoy evidence, counts deduplicated
calls, and excludes synthetic entries from normal permission/advertisement review
findings. Name-aggregated activity is labeled when it includes decoys. Reusing a
name for a real tool can yield mixed evidence until retained reports expire.

A decoy call can come from legitimate exploration or a naive agent; it is not proof
of malicious intent. This slice does not auto-block callers, measure false-positive
rates, generate seeded names, record initialization events, remotely deliver decoy
configuration, or provide a labeled test-trigger flow. Configuration requires an
application deployment. Those remain separate roadmap work. No low-false-positive
or caller-containment guarantee is made.

### Caller-attributed enumeration (alpha.13)

With `discovery` and `sharedRuntime.reportCaller: true`, authenticated `tools/list`
reports carry the same property-scoped pseudonym as tool calls. Raw identities,
credentials and scopes are not uploaded. Attribution stays off by default.
The hosted receiver must support caller-attributed catalogs before enabling this
SDK version; older receivers reject the new optional field without interrupting
tool listing. Listings with no visible tools also generate an empty catalog.

Caller timelines show enumeration separately from calls and decoy trips. Listing
is normal client behavior, not an enforcement decision. Large listings are split
into batches of up to 64 tools; each batch is a report, not a distinct listing
count. Unattributed older catalogs are never assigned to a caller retrospectively.
Initialization and automatic containment remain outside this feature.
