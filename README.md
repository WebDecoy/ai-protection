# WebDecoy AI Protection

Bot and abuse protection for AI-powered applications. A small Node.js SDK that
checks requests before your application invokes a model. Customer-defined rules run
locally; proprietary bot detection runs in WebDecoy. See [architecture](ARCHITECTURE.md).

**Alpha release: `0.1.0-alpha.12`.** Integration mechanics are tested;
real-world detection accuracy and provider cost savings have not been established.
Requires a WebDecoy property, a property-scoped API key, and a compatible WebDecoy
service deployment. This repository contains the SDK, not the detection service.

## Install

```sh
npm install @webdecoy/ai-protection@alpha
```

Node.js 22.22.3 or newer is required. The SDK has no runtime npm dependencies.
Experimental Cloudflare Workers admission support is available through the
[`/workers` entry point](WORKERS.md), with Node compatibility enabled. Workers
concurrency and budgets, and other Edge runtimes, are not supported. Licensed under [Apache-2.0](LICENSE).

Set `WEBDECOY_URL=https://ai-protection.webdecoy.com` on your server.
Create a property-scoped API key with Write Detections permission in WebDecoy,
then review results at [AI Protection](https://app.webdecoy.com/ai-protection).

## Integrate

For Node.js, create the instance once in a **server-only module**, then call it inside your
existing authenticated and validated AI endpoint:

```ts
import { createAIProtection } from '@webdecoy/ai-protection';

const protect = createAIProtection({
  webdecoyUrl: process.env.WEBDECOY_URL!,
  webdecoyKey: process.env.WEBDECOY_KEY!,
  propertyId: process.env.WEBDECOY_PROPERTY_ID!,
  subjectSecret: process.env.WEBDECOY_SUBJECT_SECRET!, // random, >=32 characters
  scopeId: 'support-chat',
  route: '/api/chat', // fixed route template; never a user ID or raw URL
  protectionMode: 'observe',
  resolveClientIP: trustedClientIP, // implement for your ingress; see setup guide
});

// Inside your route, AFTER auth, origin checks, input validation and quotas:
// return protect(request, () => callYourModelAndReturnResponse(request.signal));
```

`trustedClientIP` and `callYourModelAndReturnResponse` represent your application's
existing infrastructure/model code; they are not SDK exports. The protected
callback returns a standard `Response` or `Promise<Response>`.

See the [Next.js / AI SDK guide](NEXTJS.md) and the [runnable local example](examples/nextjs).
The guide documents trusted IP handling, cancellation and the complete integration flow.

## What happens

1. Your application validates and authenticates the request.
2. Local rules evaluate server-supplied context. An enforced local denial stops
   immediately, without waiting for cloud detection. Otherwise the SDK verifies its WebDecoy
   property/account binding and sends request metadata.
3. Cloud observation records bot verdicts without enforcing them. Each local
   rule has its own observe/enforce mode; explicit customer policies still apply.
4. With both local and account enforcement enabled on an entitled plan, block and
   challenge verdicts return HTTP 403 before the callback.
5. An allowed response streams through unchanged.

WebDecoy outages **allow requests by default**. A missing or mismatched account
binding falls back to observation and skips scoring. Missing trusted IPs also skip
scoring and emit a degraded-coverage event. Successful chat alone does not prove
protection is connected. Cancelled requests never start the protected callback. Enforced local rule errors
return 503 by default; this is separate from remote detector failure behavior.
A challenge verdict has no interactive verification UI in this alpha.

## Data and scope

The SDK sends IP address, method, URL pathname (not query), user agent, header
names, accept-language and accept-encoding values for detection. Separate reporting
sends decision/check metadata and handler outcomes; see [the full schema](ARCHITECTURE.md#reporting-and-hosting-lifecycle). It does **not** send request
bodies, prompts, session cookies, authorization values or model responses.
When browser evidence is explicitly enabled, only the WebDecoy receipt cookie is sent. Avoid sensitive
identifiers in URL paths. Keys stay in your server environment.

This SDK provides request admission, not prompt-injection filtering, verified
agent identity, model/tool authorization or spending caps. Keep your existing
authentication, origin checks, request limits and user quotas. A metadata verdict
is not proof that a caller is human.

## Explicit decisions and reporting

The callable wrapper remains available. For custom enforcement use
`protect.check(request, trustedContext)`, inspect `conclusion`, `reason`,
`degraded` and `checks`, then call `protect.report(decision, outcome)` once.
Reporting is best-effort and separate from the decision. Attach `waitUntil` to
hosting lifecycle support; see [the contract and examples](ARCHITECTURE.md).
Application outcomes, including local denials and unavailable checks, are sent
asynchronously to WebDecoy and your observation sink. The dashboard identifies
these as SDK reports, separately from detector evidence. Central delivery requires
the compatible reporting endpoint; `reportToWebDecoy: false` disables it.

## Configuration

Required: `webdecoyUrl` (HTTPS AI Protection API origin; HTTP allowed only on loopback),
`webdecoyKey`, `propertyId`, `scopeId`, `subjectSecret`, `resolveClientIP`.

Optional: `protectionMode` (`enforce` by default; start pilots with `observe`),
`detectorFailureMode` (`open` by default), `detectorTimeoutMs` (1000),
`baselineLimit` (10), `baselineWindowMs` (60000), `rules` (none),
`onObservation` (JSON stdout), `waitUntil` (hosting lifecycle hook),
`reportingTimeoutMs` (1000), `maxPendingReports` (100), and `reportToWebDecoy` (true).
The baseline is a process-local shadow comparison, not an enforced rate limit.

Verified account bindings cache for 60 seconds; failures cache for 5 seconds.
A cold binding lookup and detector call each have their own timeout (roughly two
seconds total with defaults). Account changes are eventually consistent.
Observation records describe admission and callback response creation, not stream
completion, model usage, blocked spend or successful provider cancellation.

## Develop

```sh
npm ci
npm test
npm run test:types
npm run check:package
cd examples/nextjs
npm ci
npm run build -- --webpack
npm test
```

Tests use a local detector and local AI model; no live keys or paid inference.
Source and release history are available in this public repository.

## Shared account quotas (opt-in)

Configure `accountQuota` from trusted server code, after authenticating and
validating the application's request:

```js
accountQuota: {
  ruleId: 'chat_v1', limit: 20, windowSeconds: 60,
  mode: 'enforce', failureMode: 'open',
  subject: authenticated => ({accountId: authenticated.databaseId}),
}
```

The subject callback is synchronous. Do not pass IDs or plan claims copied from
browser headers/body. Optional `sessionLimit` and `sessionId` add a stricter session
cap beneath the account cap; rotating sessions does not reset the account limit.
The quota rule is independent of cloud/dashboard detection mode. It defaults to
observation, with a one-second timeout and fail-open for state errors. Use
`failureMode: 'closed'` explicitly to return 503 when a hard quota cannot be checked.
Enforced exhaustion returns 429 and `Retry-After`; explicit `check` callers use
`decision.retryAfterSeconds` and must enforce the decision themselves.

This uses the hosted `/api/v1/sdk/ai-abuse/quota` endpoint.
Observation and enforcement share counters. In default schema 1, each allowed
admission consumes a unit, including retries and requests later cancelled/blocked
by another check; there are no automatic retries or refunds. Opt-in schema 2
adds bounded recovery of the same admission (see below). Counters
use fixed UTC windows: up to twice the limit can pass across a window boundary.
This does not bound concurrent inference or establish model-cost savings.

The account ID is HMAC-SHA256 pseudonymized with the property and rule ID before
transmission; no raw context or prompt is added to quota/report payloads. The
secret defaults to `subjectSecret` and must be identical across replicas. An
explicit `accountQuota.subjectSecret` can separate quota identity from other SDK
observations. Rotating it resets quotas; coordinate rotation after the longest
window. These identifiers are correlatable pseudonyms, not anonymous data.
Backend retention removes expired buckets on access and in an hourly sweep;
healthy maximum retention is the 24-hour maximum window plus one sweep, with
possible extension during cleanup failure/backlog.

One rule ID binds immutable limit/window/session-limit settings. Inconsistent
replicas receive an unavailable check, governed by the configured failure policy;
new policy versions deliberately create fresh counters. Bounds are 32 policies
and 10,000 active account/session buckets per property. Quota-store errors and
capacity limits do not change the detector's separate failure policy. State can
commit just before a timeout, so a failed check does not prove no unit was used.


## Distributed concurrency

Optional concurrency policy shares per-account and property/feature capacity
across app replicas. Defaults are observe/open; detector failure policy is
independent. Authenticate first and derive the account ID from trusted server
state. Keep rule IDs and subject secrets identical across replicas.

Configure `concurrency: {ruleId: 'chat_v1', accountLimit: 2, featureLimit: 20,
subject: user => ({accountId: user.databaseId})}` and call
`protect.concurrent(request, async ({signal}) => ({response, finished}), user)`.
Propagate signal to the provider. `finished` must be a Promise resolving only
when all protected work has ended. The original Response is returned untouched.
Use the host's waitUntil hook where required and validate host execution limits.
The ordinary callable wrapper rejects concurrency configuration; `check` alone
does not acquire a lease.

Heartbeat TTL defaults to 30 seconds and maximum runtime to 300 seconds.
Confirmed completion releases immediately. Errors, cancellation, crashes and
lease loss retain capacity until maximum runtime, because cancellation is not
proof a remote provider stopped. Upstream work must honor cancellation and have
a real runtime bound. Fail-open outages cannot guarantee a concurrency cap.
Released replay tombstones remain 24 hours: the pilot cap is 10,000 granted
acquisitions/day/property and 32 policies/property. This is not a throughput SLA.


## Upstream model budgets

Opt-in token and integer micro-USD budgets reserve a conservative maximum before
each provider attempt and reconcile only confirmed usage. Configure account,
customer-organization and feature limits, a fixed UTC window, a trusted subject
callback, and an explicit versioned model price catalog. Rates use micro-USD per
million input/output tokens. Unknown prices are rejected before work; an explicit
zero rate is permitted for intentionally free model usage, not unmeasured hosting.

Use exported `createAIBudget(options)`, then
`budget.run(user, {priceId, maxInputTokens, maxOutputTokens}, work, signal)`.
The callback gets `{provider, model, maxInputTokens, maxOutputTokens, signal}`
and returns `{value, finished: Promise<BudgetUsage|null>}`. The result contains
the identical `value` and an `accounting` Promise; keep the latter alive using
host waitUntil where needed. `BudgetDenied` carries 429/503 and Retry-After
metadata before work. Missing/rejected usage retains the maximum charge.

Defaults are observe/open, independently of detector availability. A hard budget
requires explicit enforce/closed plus correctly enforced input/output bounds,
accurate complete prices/usage and no hidden provider retries. Every retry,
fallback and tool-loop model call needs a fresh reservation. Cancellation/crash/
missing usage never automatically refunds charges. An actual overrun records debt
and signals overrun but cannot undo an already-billed call. Fixed-window accounting
is based on admission time, not the provider's invoice period.

There is an Ollama final-usage normalizer for native generate/chat metadata;
other provider clients need a reviewed application adapter. The SDK never parses
or stores prompts/outputs to meter usage. This does not change WebDecoy plans or
create a subscription meter.

## Optional browser evidence

Add `data-runtime-evidence="true"` to the existing WebDecoy scanner tag and set
`browserEvidenceOrigin` to the exact HTTPS site origin (no trailing slash).
Requires the compatible ingest/CDN deployment and a same-origin AI endpoint.
The SDK forwards only the property-specific WebDecoy receipt, never the other
cookies. The signed observation expires after 60 seconds and is bound to the
property, origin, IP and user agent. Missing or invalid evidence fails open and
adds an unavailable `browser_evidence` check; a clean receipt never overrides
another denial. This is optional risk evidence, not proof of a human or identity.
Start in observe mode; real-world accuracy has not been established.

In browser code, optionally `await prepareBrowserEvidence()` from
`@webdecoy/ai-protection/browser` before your existing chat fetch. The helper
waits at most 1500ms by default and returns `{available: boolean}`. Continue the
request regardless; server admission decides. Load the opted-in tag first.

## Model-attempt reports

Budget hooks now send separate start/finish events to WebDecoy automatically.
Each attempt has a random call ID; pass the admission decision's request ID in
`requestId` on the budget call (`decision.id`). The run returns `callId`.
Keep `run.accounting` alive with host lifecycle support, then `budget.flush()`
can drain queued reports. Budget reporting accepts `waitUntil`,
`reportingTimeoutMs`, `maxPendingReports` and `reportToWebDecoy`.

The dashboard labels callback starts and final usage as SDK-reported and joins
retained reservations to confirm accounting. Neither is a provider invoice.
Missing usage is unknown, and avoided cost is unavailable—not inferred from
request denials. Usage events contain numeric tokens, configured rates and price/
rule codes, but no prompts, responses, model names or raw user identities. Use
non-sensitive price/rule codes. Reporting remains bounded and best effort;
failures do not change provider results, trigger retries or refund charges.
Requires the compatible usage endpoint; old backends may log reporting failures.

## Verify the model path without a paid provider

From an SDK source checkout, `scripts/doctor-model.mjs` runs synthetic checks in
your own process. It builds protection from your options against a stand-in
WebDecoy runtime on loopback and a counting stub provider. Nothing contacts a
model provider, the real runtime or your users.

```js
import {checkModelProtection} from './scripts/doctor-model.mjs';
import {createAIProtection, createAIBudget} from '@webdecoy/ai-protection';

const report = await checkModelProtection({
  protection: protectionOptions,          // what you pass to createAIProtection
  budget: budgetOptions,                  // optional: what you pass to createAIBudget
  allowedContext: {plan: 'pro', account: 'test-account'},
  deniedContext: {plan: 'blocked', account: 'test-account'},  // optional: a context your enforced rule refuses
  createProtection: createAIProtection,   // check your installed version
  createBudget: createAIBudget,
});
console.log(JSON.stringify(report, null, 2));
```

Checks, each with an independent provider call count:

| Check | Verified when |
| --- | --- |
| `allowed` | an allowed context reaches the provider exactly once |
| `local_denial` | `deniedContext` is refused and the provider is never called |
| `detector_block` | a block verdict stops the call in enforce mode, or is only recorded in observe mode |
| `streaming` | the provider's stream arrives unchanged and in order |
| `cancellation` | aborting the request stops the provider work |
| `outage` | with the runtime returning 503, the result matches your failure modes: deny with 503 for closed enforced controls, otherwise allow with degraded coverage |
| `budget_settlement` | a reserved call settles and its usage reports carry the admission's request ID |
| `budget_denied` | an exceeded budget stops the call in enforce mode, or is only recorded in observe mode |

Diagnostics label browser receipts (unconfigured, forwarded or not forwarded;
validity is never checked locally because receipts are signed by WebDecoy),
reporting (disabled, delivered, whether a host lifecycle hook is set), request
correlation and budget settlement. The report lists every value the doctor
overrides and what it does not exercise: your route handler and provider client,
real detection verdicts, cold-start outages and limit exhaustion. Correlation is
verified for the documented pattern (`check()`, then `budget.run` with
`requestId: decision.id`); your handler must pass the ID the same way.

## Release and runtime contract

The SDK is published under Apache-2.0 on the `alpha` npm dist-tag. WebDecoy's
hosted detection service is separate and is not included in this package.

Control-plane JSON responses are capped at 64 KiB (2 KiB for stateful controls).
Detector/config timeouts default to 1000ms each, maximum 10000ms. Trusted IP
resolution has its own `clientIPTimeoutMs` (1000ms default, maximum 10000ms) and
receives `{signal}` as its second argument. On timeout, cloud detection is skipped
with degraded coverage. Resolver exceptions remain application errors; caller
cancellation always prevents the callback. Resolvers must cooperate with abort.

Set `route` to a stable template such as `/accounts/{id}/chat` when paths contain
identifiers. Otherwise the pathname is used, with query/fragment omitted. The SDK
does not trust forwarding headers automatically. Header names and the documented
metadata values still leave the app; never place secrets in those values.

Reporting timeouts and queue capacity each have a maximum of 10000 (ms/events).
Application rules and hooks must not block the event loop. There is no unconditional
wall-clock SLA for arbitrary customer code or uncooperative hosting runtimes.
See the installation and configuration sections above for supported versions and setup.

### Recovering an uncertain quota admission (opt-in)

After your runtime supports quota schema 2, set `accountQuota.idempotency: true`.
The SDK generates one server-side operation ID and retries the quota RPC at most
once after transport/5xx/malformed-response failures, keeping the same ID and
payload. `timeoutMs` applies per attempt (at most twice that time overall).
Cancellation stops retries; HTTP 4xx stops retries; there is no schema-1 fallback.
Legacy configuration remains schema 1 with no automatic retry.

To recover the same admission across requests/processes, generate and persist
`createQuotaOperationId()` in trusted server state, and supply
`accountQuota.operationId: context => context.persistedOperationId`. The local
quota check exposes `operationId`; it is omitted from central reports. Never take
this ID directly from an untrusted browser or reuse it for different operations.

IDs expire ten minutes after creation (database clock, 30-second forward skew
allowance). Expired IDs are rejected even after receipt cleanup. Capacity is
10,000 retained operations/property, including denials. Identical replays return
the original decision; changed payloads conflict. An unresolved response is
`account_quota_outcome_unknown`, distinct from a known quota denial. Existing
open/closed settings still apply. After expiry, do not mint a fresh ID to retry an
unknown operation blindly. The stored quota count/retry hint is an original-window
snapshot, not current quota state.

Only admission is deduplicated. Repeated application/model calls still require
application-level idempotency. The hosted runtime must support quota schema 2 before enabling this option.

## Action authorization (Alpha)

Version `0.1.0-alpha.3` includes an action boundary at `@webdecoy/ai-protection/actions`. See the
[record-action example and integration contract](examples/actions/README.md).
This API requires your server authentication and application authorization.
An [Auth0 access-token example](examples/auth0/README.md) verifies signed tokens
and maps tenant membership. The [MCP adapter](MCP.md) provides a separate `/mcp` entrypoint for stateless
HTTP tool dispatch starting in `0.1.0-alpha.4`.
It requires the optional, pinned MCP SDK peer. Optional shared quotas, concurrency and hosted
action events are documented in the action guide and use the hosted AI Protection runtime and dashboard.
To install it, start with `scripts/doctor-mcp.mjs detect`, then verify the running route (including an
outage) with `doctor-mcp.mjs check`; see the [MCP setup guide](examples/mcp/SETUP.md). From `alpha.19`,
every tool result carries the action ID used in its reported evidence.

## Weighted tool work (Alpha)

Node alpha.5 adds weighted tool-work reservations and tenant concurrency. See
[bounded tool work](WORK.md) for installation, enforced application bounds and
retry/unknown-outcome semantics. These units are separate from model usage and billing.

### Opt-in tool caller attribution

With a runtime supporting caller evidence, set `sharedRuntime.reportCaller: true`
on `createActionProtection`. It defaults to false. Hosted reports and `onEvent`
then include `caller: {schema: 1, source: 'application_auth', id: '<digest>'}`
after successful authentication, including subsequent permission denials.
Failed authentication, rejected arguments before authentication, and unknown tools
have no caller attribution. Existing request admission reporting is unchanged.

The SDK derives this HMAC-SHA256 pseudonym from the server-owned `subjectSecret`,
a dedicated versioned domain, property ID, issuer, application tenant and subject.
Replicas must use the same secret to correlate callers. Raw subjects, issuers,
tenants, scopes, tokens and tool arguments are not added to reports. OAuth clients
and agent signers are not treated as the authenticated subject. Your authentication
hook must verify credentials and tenant membership; WebDecoy does not independently
verify those credentials from this report, and a pseudonym is not a unique person.

Use a randomly generated secret of at least 32 bytes and store it server-side.
Rotating it changes pseudonyms and also changes existing shared-limit identities
that use this secret; coordinate rotation because it can reset quota continuity.
Historical pseudonyms are not relinked. AI Protection displays a seven-day receipt
window and existing report retention purges expired records in bounded background
sweeps. Counts cover reported, consistently attributed actions only; dropped reports,
older SDKs and conflicting bindings leave gaps. Install server support before
enabling this option: older runtimes reject the additional field.
