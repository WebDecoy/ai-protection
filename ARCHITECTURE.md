# Local rules + cloud detection

The SDK makes deterministic application-policy decisions locally and delegates bot
classification to WebDecoy. No detector weights, threat intelligence, WebAssembly
engine, prompt inspection or remote executable policies are shipped here.

```text
Customer authenticates, validates input and loads trusted application context
  → synchronous local rules
      enforced denial/error → decision (no blocking cloud check)
      otherwise → resolve trusted IP → WebDecoy account/config + detection
  → immutable combined decision
  → customer's application or convenience wrapper enforces it
  → response streams unchanged
  → bounded, best-effort central reporting and application observation sink
```

## Decision API

`createAIProtection(options)` remains callable as
`protect(request, handler, context?)`. It also exposes:

- `check(request, context)` → immutable decision, no automatic normal-outcome report.
- `report(decision, outcome?)` → best-effort reporting promise; once per decision
  created by that instance. Foreign/already-reported decisions are ignored.
- `flush()` → waits for currently queued reports up to their individual timeouts.

A decision contains `id`, `conclusion` (`allow`/`deny`), a stable `reason`, denial
`status`, `degraded`, and `checks`. Each check has its source, mode, verdict, reason
and duration. A remote denial observed in cloud observation mode remains visible
in `checks` while the overall decision allows. Missing IP/account/detector or a
failed local rule marks coverage degraded; deliberate remote skipping after a
local denial does not.

`check()` does not invoke a model or grant authentication. Keep auth, origin
validation, input validation and quotas before it. For direct use, recheck
`request.signal.throwIfAborted()` immediately before starting inference. The
wrapper does this automatically and returns the original Response unmodified.
Cancellation during remote admission throws and emits a best-effort cancellation
record; it never produces a usable allow decision.

## Trusted context and local rules

Context comes from the application's server code. The SDK cannot establish its
truth: use verified sessions, database entitlements and validated operation names.
Never spread a request body into this context or accept a browser's plan/user claim.
Context is passed only to local rules. The SDK neither serializes it to detection
nor copies it into observation records.

```ts
const protect = createAIProtection<{canGenerate: boolean}>({
  // ...existing connection and trusted-IP configuration
  rules: [{
    id: 'generation_entitlement',
    mode: 'enforce',
    evaluate: context => ({
      allowed: context.canGenerate,
      reason: 'generation_entitlement_required',
    }),
  }],
});
```

Rules must be synchronous, deterministic and cheap; load external state before
calling protection. A rule returns `{allowed, reason?, status?}`. Denial status
may be 403 or 429. `id` and `reason` must be stable non-sensitive codes: a lowercase
letter followed by up to 63 lowercase letters, digits or underscores. Do not put
user identifiers, prompts or exception messages in codes; these enter reports
and denial reasons can reach the caller.

Rules default to **observe**. Each rule's mode is independent of cloud
`protectionMode`, plan entitlement and the dashboard's AI mode. Setting cloud
observation does not disable explicitly enforced customer rules. Customer rules
are application policies, not paid WebDecoy detection features.

All local rules run in declaration order; the first enforced denial determines
HTTP status/reason. Local allow means continue evaluation, never bypass cloud
protection. Any enforced local denial skips the blocking detection request; reporting follows asynchronously. Rule throws,
malformed values and accidental promises are `local_rule_error`; raw exceptions
are never logged. A rule in enforce mode defaults to `failureMode: 'closed'`
(503); explicit `open` permits later checks. Observe rules never enforce errors.

## Availability matrix

| Condition | Default outcome |
|---|---|
| Enforced local rule denies | Deny locally, including during a WebDecoy outage |
| Enforced local rule fails | 503, unless that rule explicitly opts into fail-open |
| Observed local rule denies/fails | Continue, expose result in decision |
| Remote detector unavailable | Allow, expose degraded coverage |
| Account unavailable/mismatched | Observe and skip remote scoring |
| Missing trusted IP | Skip remote scoring; successful local checks still apply |
| Report fails, times out or queue fills | Decision/response unchanged; log a generic warning |
| Caller aborts | Stop; never start the protected callback |

Only the existing verified account configuration is cached (60 seconds; failures
5 seconds). We intentionally do not cache detector allow verdicts, implement
distributed quotas or turn the process-local shadow counter into a spend limit.
A secure decision cache needs explicit scoping, policy versions and invalidation;
cached allow results must not accidentally bypass fresh checks or counters.

## Reporting and hosting lifecycle

The remote `/sdk/detect` request still creates its existing server-side detection
record. A separate `POST /api/v1/sdk/ai-abuse/reports` endpoint receives the SDK's
final decision/outcome, including local-only denials and degraded checks. The
property-scoped key and matching `X-WebDecoy-Property-ID` assertion bind attribution;
the payload cannot select a tenant. Unknown fields are rejected. Only request ID,
timestamp, decision/reason, check IDs/sources/modes/verdicts/durations, degraded
status, handler invocation/status and action are sent. Prompts, user IDs, context,
raw IPs and subject hashes are excluded from this reporting payload.

Central reporting is enabled by default (`reportToWebDecoy: true`). Set it to
false to keep application observation without sending these reports. The local
`onObservation` sink still defaults to JSON stdout and is independent: a failing
custom sink cannot prevent central delivery, and vice versa. Do not place sensitive
values in rule IDs/reason codes.

Ingest deduplicates by organization/property/request ID: the first accepted report
wins, including its receipt time. There are no automatic retries. Reports are
bounded to 32 KiB and 33 checks (32 local rules plus cloud). The pilot endpoint
limits traffic to 6000 reports/minute per source IP with a burst of 200; excess
reports are dropped by this SDK after a generic warning, without affecting chat.

The dashboard presents these as **SDK-reported application decisions**, separate
from server-derived detector evidence. They are not summed into detection counts,
charged as detections, or treated as proof of blocked inference or savings. The
same request ID lets users correlate the two sources. Counts use receipt time;
reports have a seven-day window and hourly retention cleanup. A prolonged outage
can prevent delivery, so this is not complete audit coverage.

`onObservation(event, {signal})` can return a promise. `report()` catches rejection,
limits outstanding reports (`maxPendingReports`, default 100), and stops waiting
at `reportingTimeoutMs` (default 1000). Sinks must honor the AbortSignal and avoid
CPU-heavy synchronous work; JavaScript cannot forcibly stop arbitrary sink code.
No retries, durable queue or exactly-once delivery is claimed.

Use `waitUntil(task)` to attach reporting to the deployment's request lifecycle.
For a Next.js route:

```ts
import { after } from 'next/server';
// In createAIProtection options:
// waitUntil: task => after(() => task)
```

This registers delivery with Next.js's supported lifecycle mechanism; the hosting
adapter must support it and execution remains subject to host duration limits.
Do not use an untracked fire-and-forget promise as a delivery guarantee. In a
long-lived Node service, call `flush()` during graceful shutdown. Tests can await
`report()`/`flush()` directly. Neither mechanism proves stream completion or actual
provider usage; wrapper records stop at Response creation.

Reference: [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after).
