> Historical validation record. Public alpha publication was approved on October 1, 2026 under Apache-2.0. See README for current installation.

# Hybrid SDK validation — 2026-09-26

- All 16 initial hybrid SDK tests passed on Node 22 and Node 24.
- TypeScript 6.0.3 checks passed, including required typed context, rejected async
  rule signatures and backward-compatible two-argument wrapper calls.
- npm tarball verification passed: exact package-file allowlist and root/subpath
  imports from an isolated consumer installation.
- Next.js 16.3.6 production build and real-server integration test passed with
  AI SDK 7.0.117. The test covers auth/input validation, a local plan denial with
  no detector call, ignored client plan claims, UI-message SSE, cloud denial,
  detector outage fail-open and the Next.js after() reporting integration.
- SDK tests additionally cover context privacy, immutable decision results,
  independent local rule error policies, cancellation, original streaming
  response identity, report rejection, lifecycle-hook failure, queue capacity
  and reporting timeout/abort.

All detector/account endpoints and model responses are deterministic fixtures.
No real customer traffic, live detection-quality evaluation or provider cost
measurement occurred. Cloud scoring still uses the existing API contract;
the initial hybrid stage used only an application sink. Central reporting was added
in the follow-up below.
No WebAssembly engine, detector verdict cache or distributed budget enforcement
is implemented. Publication and the source license decision remain pending.

## Central reporting follow-up

- 19 SDK tests pass, including the explicit payload allowlist, local denial
  without scoring, central delivery failure isolation, and telemetry opt-out.
- TypeScript declarations and isolated npm tarball imports pass.
- The WebDecoy ingest repository integration test runs this SDK over HTTP against
  the actual Go report handler and verifies database persistence of a local denial.
- Backend tests with real PostgreSQL migrations cover tenant/property isolation,
  separate report counts and seven-day retention cleanup. Ingest tests cover
  strict schema/size validation, property assertion, immutable deduplication,
  and storage failures.
- The dashboard's four browser tests and development build pass. This is local
  integration validation; nothing is deployed and no live customer account was used.
