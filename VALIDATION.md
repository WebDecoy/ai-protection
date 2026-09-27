# Hybrid SDK validation — 2026-09-26

- All 16 SDK tests passed on Node 22 and Node 24.
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
local-only reports use the application sink and are not collected centrally yet.
No WebAssembly engine, detector verdict cache or distributed budget enforcement
is implemented. Publication and the source license decision remain pending.
