# Bounded tool work (Alpha)

The Node action and MCP APIs support optional weighted tool-work reservations.
Available in `@webdecoy/ai-protection@0.1.0-alpha.5`. Requires the
`/api/v1/sdk/ai-abuse/work` contract enabled on the hosted runtime. Go/Python model budgets
and invocation controls remain available, but do not expose this new weighted
operation API. The first integration is the TypeScript MCP tools adapter.

## Configure at the action, before execution

```js
limits: {
  work: {
    ruleId: 'search_work_v1',
    windowSeconds: 60,
    maxUnits: 11, // one fixed unit plus at most five rows at two units each
    limits: {caller: 22, tenant: 44, tool: 88},
    mode: 'enforce',
    failureMode: 'closed',
    measure: result => result.workUnits, // server-computed, synchronous, confirmed
  },
  concurrency: {
    ruleId: 'search_parallel_v1', accountLimit: 1, featureLimit: 10,
    mode: 'enforce', failureMode: 'closed',
  },
  tenantConcurrency: {
    ruleId: 'tenant_search_parallel_v1', accountLimit: 2, featureLimit: 10,
    mode: 'enforce', failureMode: 'closed',
  },
}
```

Use `sharedRuntime` on the action/MCP handler. No browser credentials, prompts,
arguments or results are sent to the work service. Verified caller identity and
tenant are hashed; an HMAC binds the action, policy version and canonical arguments
to the operation. Use a stable server-only subject secret. Changing that secret or
rule IDs creates new accounting identities; rotate/drain deliberately.

All three unit allowances are evaluated atomically across runtime replicas before
callback dispatch. `caller` is scoped to issuer/tenant/subject, `tenant` is scoped
to issuer/tenant, and `tool` is shared within this property's rule. Zero/omitted
limits disable that dimension; at least one positive limit is required. Distinct
tools need distinct rule IDs. Reconnecting or creating a new MCP session does not
reset the identity allowance. Invocation quotas count attempts separately; model
budgets count tokens separately. These units never become a WebDecoy billing meter.

Existing `concurrency.accountLimit` is per caller; `tenantConcurrency.accountLimit`
is per tenant. Each `featureLimit` is property/rule-wide. Admission denial releases
already acquired slots; unconfirmed work keeps its slots until lease expiry.
Lease expiry requests cooperative cancellation, not proof a remote operation stopped.

## Enforce resource bounds in the application

`maxUnits` must be a conservative upper bound you actually enforce. The SDK provides
`context.work.maxUnits` to the callback, but cannot constrain arbitrary database or
storage work. Validate requested bounds before dispatch, apply tenant predicates and
row limits at the data source, and check byte lengths **before** appending/sending
export payload. Do not fetch an unbounded result and trim it afterward.

The [bounded search/export example](examples/mcp/work-tools.mjs) implements:

- Search: at most five rows, weight `1 + 2 × returned rows`, reserve 11 units.
- Export: at most 256 UTF-8 payload bytes, weight `16 + payload bytes`, reserve 272.
  Transport framing/JSON encoding are not included in that payload-byte allowance.
- Forbidden admin: application authorization denies before any callback.

The synthetic source contains fixed small records. A real data source must enforce
its own database scan, CPU/time and storage-read bounds too; a row limit is not a
claim that a query scans only those rows. The separate weights use separate rules,
not interchangeable token or monetary estimates.

Run `node examples/mcp/start-work.mjs` after configuring the existing Auth0 example
variables and `WEBDECOY_URL`, `WEBDECOY_KEY`, `WEBDECOY_PROPERTY_ID`, and
`WEBDECOY_SUBJECT_SECRET`. The fixture binds to loopback and makes no model calls.
It requires an updated runtime. Replace its single-subject allowlist with current
application membership for an actual customer deployment.

## Settlement, failures and retries

After a completed callback, a synchronous `measure(result, context)` may report
confirmed integer usage between zero and `maxUnits`. Without it, the fixed maximum
weight is charged. Confirmed lower usage releases the difference in the original
admission window. Never measure from untrusted request claims. Errors, cancellation,
crashes, asynchronous/invalid measurement, excess usage and missing/failed settlement
keep the conservative maximum charged. Successful results survive reporting or
settlement failure and expose unknown accounting evidence.

Unknown work is never refunded just because a lease or settlement deadline expires.
A hard ceiling depends on application-enforced maximum work, enforce/closed settings,
and bounded completion. Observe/open can execute without a confirmed reservation and
must not claim a ceiling. Detector fail-open is separate from work-state failure.

A reservation has a server-generated timestamp/UUID operation ID. For recovery across
application retries, persist an ID from `createQuotaOperationId` (exported from
`@webdecoy/ai-protection/fetch`) in trusted application state, and provide it through
`work.operationId(context)`. Do not accept an arbitrary client ID or use MCP message,
agent or session IDs as this key. Reuse requires the same caller/tenant/tool, bounds,
policy and argument binding. Conflicts deny even in open mode.

The SDK makes no automatic work-RPC or callback retries. An identical reserve replay
returns accounting evidence but **never grants another dispatch**; the SDK returns
`work_replay` (409). Lost admission replies may therefore consume capacity without
executing work. A changed retry returns `work_conflict` (409). Return stored business
results through your own idempotency layer when appropriate. Never mint a new ID to
retry an unknown write blindly. Application/provider idempotency remains necessary;
this is not an exactly-once side-effect guarantee. Identical settlement is idempotent;
conflicting or over-bound settlement is rejected without lowering the charge.

## Windows and evidence

- Fixed UTC-aligned windows: 1–86,400 seconds. Boundary bursts are possible; use
  concurrency controls separately. Limits/maxima: integer units up to 10^12.
- IDs: ten-minute admission lifetime, at most 30 seconds future skew; expired IDs
  remain invalid even after receipts are purged. Settlement deadline: one hour.
- Receipts retained through the window end plus 24 hours. Unknown charge persists
  for its admission window; this is not a lifetime allowance or infinite ledger.
- At most 32 work rules and 10,000 retained operations per property, including denials.
  Capacity failures follow state-failure policy. Existing replay works at capacity.
  These are operational bounds, not commercial plan changes.
- Reports show reserved/charged units, remaining allowance at admission and
  reserved/settled/unknown/unavailable/denied/replay status. Remaining is a snapshot,
  not current balance. Delivery is best effort; missing reports do not imply no work.
  Local callback completion is not independent proof of a remote side effect.
