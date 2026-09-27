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
bodies, prompts, cookies, authorization values or model responses. Avoid sensitive
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
