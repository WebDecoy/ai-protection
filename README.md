# WebDecoy AI Protection

Bot and abuse protection for AI-powered applications. A small Node.js SDK that
checks requests before your application invokes a model. Customer-defined rules run
locally; proprietary bot detection runs in WebDecoy. See [architecture](ARCHITECTURE.md).

**Alpha pilot. Initial npm publication pending.** Integration mechanics are tested;
real-world detection accuracy and provider cost savings have not been established.
Requires a WebDecoy property, a property-scoped API key, and a compatible WebDecoy
service deployment. This repository contains the SDK, not the detection service.

## Install

After the first npm release:

```sh
npm install @webdecoy/ai-protection@alpha
```

Until then, clone this repository, run `npm pack`, and install the resulting
`webdecoy-ai-protection-0.1.0-alpha.1.tgz` in your application. Node.js 22 or newer
is required. The SDK has no runtime npm dependencies. Edge runtimes are not supported.

## Integrate

Create the instance once in a **server-only module**, then call it inside your
existing authenticated and validated AI endpoint:

```ts
import { createAIProtection } from '@webdecoy/ai-protection';

const protect = createAIProtection({
  webdecoyUrl: process.env.WEBDECOY_URL!,
  webdecoyKey: process.env.WEBDECOY_KEY!,
  propertyId: process.env.WEBDECOY_PROPERTY_ID!,
  subjectSecret: process.env.WEBDECOY_SUBJECT_SECRET!, // random, >=32 characters
  scopeId: 'support-chat',
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

Required: `webdecoyUrl` (HTTPS ingest origin; HTTP allowed only on loopback),
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
[Release instructions](RELEASING.md) cover publishing the public npm package.

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

This needs the shared quota backend (migration 78 and `/api/v1/sdk/ai-abuse/quota`).
Observation and enforcement share counters. Each allowed admission consumes a
unit, including retries and requests later cancelled/blocked by another check;
there are no automatic retries, refunds, or reusable idempotency permits. Counters
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


## Distributed concurrency (unpublished, #1373)

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
The private app repository's `integrations/ai-abuse/CONCURRENCY.md` documents the
wire contract, failure behavior, deployment order and validation evidence.


## Upstream model budgets (unpublished, #1374)

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
create a subscription meter. The private app's `integrations/ai-abuse/BUDGETS.md`
contains examples, supported workloads, privacy, capacity and release gates.

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
