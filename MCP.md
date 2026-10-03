# MCP tool protection (Alpha)

`@webdecoy/ai-protection/mcp` is a Node HTTP handler for a closed registry of
protected tools. It runs in your application's backend. Your MCP traffic stays
on your server; configured shared limits and sanitized action reports use the
WebDecoy runtime. Your application owns authentication, tenant membership and
resource authorization.

## Install

Available in `0.1.0-alpha.5` and later compatible alpha releases:

```sh
npm install @webdecoy/ai-protection@0.1.0-alpha.7 @modelcontextprotocol/sdk@1.31.0
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
hashes. The AI Protection dashboard shows **Advertised MCP tools**, including
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
