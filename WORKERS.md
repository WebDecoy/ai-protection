# Cloudflare Workers

The `@webdecoy/ai-protection/workers` entry point provides experimental Workers
support for request admission, local rules, shared account/session quotas and
best-effort reporting. Node compatibility is required. Control-plane requests use manual redirects and
reject non-success responses without following redirects or forwarding credentials.
Local workerd tests cover
these features; a deployed staging canary remains required before production use.
Concurrency leases and budget settlement are not supported by this entry point.

## Integration

Create a fresh protection object **inside `fetch()` for each incoming request**.
It binds that request and execution context, so `protect()` and `check()` do not
take a Request argument. Never store the returned object in module scope. This
keeps account refresh promises, report queues and `ctx.waitUntil` request-scoped.
Each request performs a fresh account lookup; the Node SDK's shared cache and
shadow baseline are not shared between Worker invocations.

```js
import {createWorkerAIProtection} from '@webdecoy/ai-protection/workers';

export default {
  async fetch(request, env, ctx) {
    // Authenticate and validate first. Derive this context from server state.
    const user = await authenticateAndValidate(request);
    const protect = createWorkerAIProtection(request, {
      webdecoyUrl: env.WEBDECOY_URL,
      webdecoyKey: env.WEBDECOY_KEY,
      propertyId: env.WEBDECOY_PROPERTY_ID,
      subjectSecret: env.WEBDECOY_SUBJECT_SECRET,
      scopeId: 'support-chat', route: '/api/chat', protectionMode: 'observe',
      resolveClientIP: trustedClientIP,
      accountQuota: {
        ruleId: 'chat', limit: 20, windowSeconds: 60, mode: 'enforce',
        failureMode: 'closed', subject: context => ({accountId: context.accountId})
      }
    }, ctx);
    return protect(() => callModel(request.signal), {accountId: user.id});
  }
};
```

`authenticateAndValidate`, `trustedClientIP` and `callModel` are application
functions. The resolver must return an IP vouched for by your ingress, or `null`
to skip detection with degraded coverage. On direct Cloudflare ingress you can
use `request.headers.get('cf-connecting-ip')`; do not assume it identifies the
original client on Worker/service subrequests. Do not trust arbitrary forwarded
headers. See [Cloudflare's header behavior](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip).

Configure Wrangler with the tested baseline:

```toml
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]
```

Store API credentials and the random subject secret (at least 32 characters) as
Worker secrets. Shared quota subjects must come from authenticated server state.
For idempotent quotas, use `idempotency: true` only with a migrated runtime and
persist a server-generated operation ID if recovery must survive request loss.
`createQuotaOperationId` is also exported from the Workers entry point.

## Streaming and lifecycle

The wrapper returns the original Response and does not read or rewrite the model
stream. Pass the application's cancellation signal to the provider. A successful
admission report describes callback/response creation, **not** stream completion,
final token usage or proof that upstream work stopped on disconnect.

Reporting is automatically attached through `task => ctx.waitUntil(task)` and is
bounded by the core reporting timeout (1000ms default, 10000ms maximum). Reporting
is best-effort; `waitUntil` is not durable delivery. Cloudflare permits up to
30 seconds of extension after the response completes or the client disconnects.
Long-running background model work needs a separate execution design. See
[Cloudflare execution context](https://developers.cloudflare.com/workers/runtime-apis/context/).

For custom decisions, use `protect.check(trustedContext)` and report exactly once
with `protect.report(decision, outcome)`. `flush()` waits only for this request's
pending reports. The adapter rejects `concurrency` at construction; it exposes
neither `.concurrent()` nor `createAIBudget`. Using the Node entry point directly
does not establish Workers support for those features.

## Run the fixture

From this repository root:

```sh
npm ci
npm exec -- wrangler secret put WEBDECOY_KEY --config examples/workers/wrangler.toml
npm exec -- wrangler secret put WEBDECOY_PROPERTY_ID --config examples/workers/wrangler.toml
npm exec -- wrangler secret put WEBDECOY_SUBJECT_SECRET --config examples/workers/wrangler.toml
npm exec -- wrangler secret put EXAMPLE_TOKEN --config examples/workers/wrangler.toml
npm exec -- wrangler dev --config examples/workers/wrangler.toml
```

For local development instead, put these four values in
`examples/workers/.dev.vars` (gitignored); no remote secret provisioning is needed.
The example imports the local SDK source. In your own project import the package
subpath shown above. Send POST `/api/chat` with `Authorization: Bearer <EXAMPLE_TOKEN>`.
The fixture returns text and invokes no model; replace its auth and callback with
your application's integration. It starts in observation mode.

## Validation and rollout

`npm run test:workers` bundles the SDK and executes the Worker in Miniflare/workerd
with a simulated WebDecoy service. It verifies local/cloud denial, original
responses, stream passthrough, pre-cancelled requests, degraded detector outages,
simultaneous requests, asynchronous report completion and idempotent quota retry.
CI runs this alongside Node, type and package checks. Protocol fixtures do not
prove remote connectivity, database contention or detection accuracy.

Before production, deploy an owned staging Worker against the real service and
verify report persistence, entitled enforcement, shared quota contention across
invocations and service outages. Before adding concurrency/budgets, validate long
streams, midstream client disconnects, provider cancellation, heartbeat failure,
lease expiry and conservative settlement when usage is unknown.
