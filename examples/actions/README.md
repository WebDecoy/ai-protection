# Protected record actions (Alpha)

Run `node examples/actions/records.mjs` from this source checkout. It performs one
permitted read, denies a cross-tenant read and an export, and rejects a forged
session. Independent counters assert exactly one read and zero exports. No paid
provider or WebDecoy credentials are needed.

The `/actions` API is available in `0.1.0-alpha.3`. It is a local dispatch boundary, not an MCP
adapter or an identity provider. `authenticate` must call your existing server
session/token verifier; the example's in-memory sessions are only a fixture.
For OAuth, your verifier must validate issuer, audience/resource, expiry and
scopes before returning a `TrustedCaller`. Never construct one from tool arguments,
unsigned identity headers or an MCP session ID. A WebDecoy API key identifies the
integrator, not the caller of the action. `clientId` is the authenticated OAuth
client, not verified agent identity or delegated-user consent. See the [Auth0 example](../auth0/README.md) for signed access-token verification.
The Auth0 example includes a live owned-provider verification command. Verified
agent signers and delegated actor chains remain unsupported.

Each registered action supplies required scopes, argument validation, application
authorization and execution. Only literal `true` admits validation/authorization.
An optional additional policy can restrict an application allow; it cannot
reverse an application deny. Authorization errors and timeouts stop execution.
There is no observation mode or detector-failure override for permissions.
Arguments are copied/frozen bounded JSON (16 KiB, depth 12, 2048 nodes). The caller
contract is copied/frozen too. Unknown actions deny; discovery filtering alone is
never authorization. Empty required scopes still require a valid authenticated
caller and application authorization. Anonymous actions are not supported here.

Admission checks have a 1-second default deadline (configurable 1–10000 ms).
Cancellation/deadline stops dispatch, even if a pending verifier later returns.
Hooks should honor cancellation and perform no protected side effects themselves.
JavaScript cannot interrupt a synchronous blocking hook. Re-check resource ownership
inside the actual tenant-scoped database query or transaction; a preflight check
cannot prevent ownership changes during execution.

`execute` must await all work. This first boundary supports completed values,
not a live response stream or detached jobs. It forwards cancellation but does not
force-stop a provider. Errors propagate without retries. Execution failure or
cancellation has an unknown side-effect outcome. A resolved callback means the
application completed its work, not independent proof of an external operation.
Shared caller/tenant quotas and concurrency are available through the opt-in
configuration below. Weighted work reservations are available in the Node SDK; see [WORK.md](../../WORK.md).
For streaming provider calls, consume and await the stream inside `execute`; only
then return a completed value. The MCP adapter owns its SSE transport lifecycle.
Returning a stream object ends the callback immediately and does not track later
stream consumption, errors or cancellation.

The optional local `onEvent` observer receives action ID, registered action name,
policy version, decision/reason and attempted/completed/unknown state. It receives
no raw caller/tenant/resource IDs, arguments, credentials or error messages. Keep
configured action and policy names free of customer data. Delivery is best effort,
capped at 100 outstanding observer calls; a hung observer drops subsequent events.
Hosted delivery is opt-in through `sharedRuntime`; it is independent of this local
observer. Do not treat events as a complete audit trail or retry an action because
an event is absent.


## Shared limits and hosted evidence

Supply `sharedRuntime` to `createActionProtection` and `limits` on each applicable
action. The published Node Alpha and hosted AI Protection runtime support these
controls and schema-2 action reports.

```js
sharedRuntime: {
  webdecoyUrl: 'https://ai-protection.webdecoy.com',
  webdecoyKey: process.env.WEBDECOY_KEY,
  propertyId: process.env.WEBDECOY_PROPERTY_ID,
  subjectSecret: process.env.WEBDECOY_SUBJECT_SECRET, // stable random secret, >=32 bytes
},
// Within the registered action definition:
limits: {
  callerQuota: {ruleId:'read_caller_v1',limit:20,windowSeconds:60,mode:'enforce',failureMode:'closed'},
  tenantQuota: {ruleId:'read_tenant_v1',limit:100,windowSeconds:60,mode:'enforce',failureMode:'closed'},
  concurrency: {ruleId:'read_work_v1',accountLimit:2,featureLimit:10,mode:'enforce',failureMode:'closed'},
},
```

Authenticate, validate and authorize first. Then consume caller quota, tenant quota,
and acquire concurrency before work. A later denial/error does not refund earlier
admissions. These are fixed-window counts, not weighted rows/bytes or a transactional
reservation of all limits. No admission recovery or automatic action retry is added.
Each rule ID must be distinct across this registry and use a consistent policy
across replicas. Versioned rules and secret rotation create new counters.

Caller identities include issuer, canonical application tenant and subject. Tenant
quotas aggregate that canonical tenant across callers and identity providers. All
subjects are secret-derived pseudonyms before transmission. Concurrency's feature
limit is shared across the property/rule; its account limit is per caller.
Defaults remain observe/open; use enforce/closed explicitly for hard admission caps.
Detector fail-open never clears application permission failures. Quota exhaustion
throws `ActionDenied` (429, `retryAfterSeconds`); closed-state errors use 503.

Leases release on confirmed completion or when no callback started. Cancellation,
errors and lost leases retain uncertain capacity per the shared runtime policy.
The callback must honor its signal and await all work. A completed result is preserved
if lease release reporting fails; no side effect is retried.

With `sharedRuntime`, action events are sent to WebDecoy using a bounded queue.
Call `await guard.flush()` during graceful shutdown. Attempt and completion are
separate immutable event IDs with one action ID. No raw identity, arguments or
results are uploaded. Dashboard events are SDK reports, not independently verified
side-effect outcomes. Missing or out-of-order reports remain possible.

Weighted tool-work reservations and tenant concurrency: [integration contract](../../WORK.md).

## Local policy changes

A guard snapshots its registered functions, required scopes and `policyVersion` at
construction. To change a local policy, construct a new guard with a new version
and route subsequent requests through it. In-flight calls retain the original
guard and event version; replacing the guard does not revoke admitted work. Keep
old guards available to flush their reports during shutdown.

Policy functions can read application state, but `policyVersion` does not
automatically reflect changes to that state. Use a consistent application-owned
snapshot if you need the version to identify exact rules. Remote managed policy
delivery, atomic fleet updates and rollback are not provided by this API.
