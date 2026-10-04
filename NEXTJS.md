# Next.js / AI SDK pilot integration

Status: local, experimental Node server adapter with local rules and cloud detection. Not published to npm or deployed.
No Next.js dependency in the adapter: it uses standard `Request` / `Response` and
can be called by other Node frameworks, but only the Next.js example is tested.

## Where it runs

```
Browser → customer's /api/chat → existing auth / input checks
                             → WebDecoy admission (metadata only)
                             → customer's model provider → original stream
```

Install in the application server that owns the model call, not the browser,
Next.js middleware, or the model provider. Node >=22.22.3 is required; Next.js Edge runtime
is not supported. For the experimental Cloudflare Workers adapter, use [the Workers guide](WORKERS.md). The application and provider traffic remain on customer
infrastructure. WebDecoy receives the client IP, URL pathname (no query string),
method, user agent, header names and accept-language/accept-encoding values.
Request bodies, session cookies, authorization values and responses are not sent
to WebDecoy. Opt-in browser evidence forwards only its WebDecoy receipt cookie.
Avoid sensitive identifiers in route paths. This is a remote metadata decision,
not proof that a caller is human. Optional browser evidence is a separate opt-in.

## Install the local pilot

From this repository:

```sh
cd ai-protection
npm pack --pack-destination /tmp
```

From the customer's application:

```sh
npm install /tmp/webdecoy-ai-protection-0.1.0-alpha.1.tgz
```

The tarball contains the adapter, declarations and shared core; it does not
need this checkout at runtime. The initial npm release is pending. Once published, install the pilot with
`npm install @webdecoy/ai-protection@alpha`. There is no automatic marketplace installer.

1. In WebDecoy, select an existing property on **AI Abuse Protection**.
2. Create a property-scoped key with Write Detections permission.
3. Set server-only environment variables: `WEBDECOY_URL` (your ingest origin),
   `WEBDECOY_KEY`, `WEBDECOY_PROPERTY_ID`, and `WEBDECOY_SUBJECT_SECRET` (random,
   at least 32 characters). Never use `NEXT_PUBLIC_` for these.
4. Create one protection instance per application scope, outside the route.
5. Call it after your authentication, origin/input checks and quotas, immediately
   before the code that invokes the model.

```ts
// app/api/chat/route.ts — incorporate into your existing authenticated route
import { createAIProtection } from '@webdecoy/ai-protection';
import { after } from 'next/server';

export const runtime = 'nodejs';
const protect = createAIProtection({
  webdecoyUrl: process.env.WEBDECOY_URL!,
  webdecoyKey: process.env.WEBDECOY_KEY!,
  propertyId: process.env.WEBDECOY_PROPERTY_ID!,
  subjectSecret: process.env.WEBDECOY_SUBJECT_SECRET!,
  scopeId: 'support-chat',
  route: '/api/chat',
  protectionMode: 'observe',
  waitUntil: task => after(() => task),
  resolveClientIP: trustedClientIP, // Your ingress-specific implementation; see below.
});

// Inside POST, AFTER your existing authentication and input validation:
// return protect(request, () => {
//   const result = streamText({ model, messages, abortSignal: request.signal });
//   return result.toUIMessageStreamResponse({ consumeSseStream: consumeStream });
// });
```

`trustedClientIP` is intentionally application supplied. Use a hosting API that
vouches for the address, or a header overwritten by a reverse proxy you control
with direct origin access blocked. Do not simply read arbitrary `X-Forwarded-For`
or `X-Real-IP` from public requests. The adapter validates a single IPv4/IPv6
address, not a comma-separated forwarding chain. Missing/invalid addresses allow
the request without scoring and emit `webdecoy_admission_skipped`; this is degraded
coverage, not successful protection. Resolver exceptions propagate as application errors. Async resolution has a
1000ms default timeout and receives `{signal}` as a second argument; timeout skips
cloud scoring as degraded coverage. Use `route` for an explicit non-sensitive
route template. Test spoofed forwarding headers against the deployed ingress before
switching to enforcement.

Keep existing request-size limits at the ingress and application. The adapter
never reads, clones or buffers the body. It does not add authentication, CORS or CSRF protection. Shared quota, concurrency
and budget controls require their separate explicit configuration; the basic
wrapper alone supplies none of those limits.

## Local policies and explicit decisions

The callable wrapper accepts a third argument containing trusted server context.
Configure `rules` to inspect that context locally, or use `protect.check()` and
`protect.report()` for custom response handling. See [the architecture contract](ARCHITECTURE.md).
Context stays local. Rule IDs/reasons are stable non-sensitive codes that can enter logs.

**Cloud observation does not override explicitly enforced local rules.** Each
local rule defaults to observe; when explicitly enforced, its denial/error remains
active during a cloud outage. The example's local `plan_input_limit` rule allows
up to 4000 input characters for its server-configured free plan, while the route's
input validation caps all prompts at 8000 characters. `EXAMPLE_PLAN` is a local
fixture setting; production should load entitlements from authenticated server state.
A `plan` field in the request body is ignored.

The example uses Next.js `after()` to keep best-effort observation delivery tied
to the request lifecycle. Local-only outcomes and degraded checks are sent to
WebDecoy's application-decision reporting endpoint and the local sink (stdout by
default). The dashboard distinguishes SDK reports from server-generated detector
records; the same request ID correlates them. `reportToWebDecoy: false` opts out
of central outcome reporting. Deploy the compatible reporting endpoint before
enabling the pilot; absent/unavailable reporting never changes request decisions.

## Behavior customers should expect

- Start with cloud and dashboard observation, and each local rule in observe mode. Review real traffic and false
  positives before enabling both enforcement settings on an entitled plan.
- Enforced cloud block/challenge: JSON 403 before the protected callback. There is no
  interactive challenge flow; handle `verification_required` in the chat UI.
- WebDecoy outage/timeouts: allow by default. Unknown account binding always
  observes and skips scoring. Missing trusted IP also skips scoring.
- Cancellation during admission: throw the request's abort reason, never invoke
  the callback. Forward `request.signal` to the AI SDK for later cancellation.
- Allowed response: exact original Response, including streaming body and headers.
  No buffering, background stream reader or response rewriting by WebDecoy.
- Logs record callback invocation and returned HTTP status, **not** stream
  completion, model invocation, tokens saved or provider billing. Existing core
  `upstream_attempted` remains false: this adapter cannot observe model activity.
- Account policy caches and per-call timeouts are documented in README. Cold remote admission can wait roughly two seconds with defaults, plus up to
  one second of IP resolution. Optional quota, lease acquisition and reservation
  each add their own deadline. See the README configuration section.

Use the AI SDK's documented `consumeSseStream: consumeStream` handling alongside
`abortSignal` when returning UI streams. Provider cancellation/billing remains
provider dependent. The adapter cannot promise refunded or unbilled tokens.

## Runnable example and validation

`examples/nextjs` contains an authenticated POST endpoint using a deterministic
local AI SDK model; it cannot incur model-provider costs. Its hardcoded test IP
is enabled only by `WEBDECOY_LOCAL_FIXTURE=1` and is not production configuration.

```sh
cd examples/nextjs
npm ci
npm run build -- --webpack
npm test
```

The test starts a real Next.js production server and a local detector/account
fixture; no secrets required. It checks authentication/input validation before
scoring, UI-message SSE response, enforced rejection, and outage fail-open.
Root `npm test` covers local decisions, reporting failure isolation, cancellation during admission, streaming cancellation,
unchanged response identity, metadata privacy and missing-IP behavior.

For a real pilot, replace the mock model with the application's existing model,
configure trusted ingress/IP resolution, connect staging ingest/backend and
verify a stored check appears for the selected property. Real abuse/legitimate
traffic labels are still needed to measure detection value. These tests validate
integration mechanics, not detection accuracy or demand.

## Why this integration, and the competitive limit

Vercel already offers [BotID for AI endpoints](https://vercel.com/kb/guide/protect-ai-endpoints-with-vercel-botid),
including browser-side challenges and server checks. This is not evidence of an
unprotected Vercel market. The hypothesis is existing WebDecoy customers and
applications wanting the same account/policies on other Node hosting. Portability
is an integration property, not yet demonstrated differentiation or demand.

The integration follows Next.js's [standard Route Handler APIs](https://nextjs.org/docs/app/getting-started/route-handlers)
and the AI SDK's [abort handling guidance](https://ai-sdk.dev/docs/troubleshooting/stream-abort-handling).
Versions pinned for this fixture: Next.js 16.3.6, AI SDK 7.0.117, React 19.3.0.
No compatibility claim for every Next.js/AI SDK version or other hosting platform.
