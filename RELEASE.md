# Supported installation and release candidate

Private alpha candidate `@webdecoy/ai-protection@0.1.0-alpha.1`.
Repository creation, public visibility, license approval and registry publication
are separate owner decisions. The current manifest has `private: true` to prevent
accidental publication. Do not advertise npm installation until it is released.

## Supported surface

- Node standard Request/Response on Node >=22.22.3; tests on 22.22.3 and 26.5.0.
- Next.js Node Route Handler fixture: Next 16.3.6, React 19.3.0, AI SDK 7.0.117.
  The tested provider is a deterministic local model, not an arbitrary SDK adapter.
- Browser `./browser` entrypoint only for optional same-origin HTTPS receipt
  preparation. It does not contain the server key or server SDK.
- No server SDK claim for Cloudflare/Vercel Edge, Deno, Bun, generic WordPress or
  Flowise. Other Node frameworks may call the Fetch API; adapters are not validated.

## Install privately

```sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run check:package
npm pack --ignore-scripts --pack-destination /your/private/artifact-directory
```

Install the exact tarball in the application (`npm install /path/to/file.tgz`) and
commit its lockfile or retain the artifact in an approved private store. Do not
make customer deployments depend on an absolute path to this development checkout.
The Next.js example uses a local file link only for development and is not included
in the package. A public npm command becomes valid only after owner-approved release.

The package check builds the real tarball, verifies its exact file allowlist,
checks zero runtime/optional dependencies and no install/postinstall hooks, prints
integrity and installs it into a separate temporary consumer. It tests exports
without access to the source checkout. No scripts execute during consumer install.

## Availability and latency

Default configured network waits before provider invocation:

- IP resolver: <=1000ms waiting; callback must be cooperative, timeout degrades open.
- Account/config: <=1000ms on cache miss (verified grant cached 60s, failures 5s).
- Detection: <=1000ms; default failure policy open.
- Optional quota: <=1000ms; default observe/open.
- Optional concurrency acquire: <=1000ms; default observe/open.
- Each optional budget reservation: <=1000ms; default observe/open.

With a synchronous resolver, basic cold/warm admission has up to 2s/1s of configured
remote waits. A resolver that stalls adds up to 1s then skips cloud calls. An async
resolver that succeeds near its timeout can make cold admission approach 3s.
All three optional controls can add another 3s before the first model attempt.
Model runtime, auth/database work, CPU scheduling, event-loop stalls and customer
rules are outside these configured waits. This is not a latency SLA. Each custom
local rule must be synchronous and cheap. Never use remote I/O inside a local rule.

Reports are asynchronous with bounded timeout/queue. `waitUntil` or Next `after`
keeps delivery alive; response streaming is not modified. Budget accounting needs
its own lifecycle wait until provider completion. On shutdown, stop accepting and
drain requests/model work, then flush admission and budget reporters. Hard process
termination can lose reports and leave conservative charges.

## Release gate

Before changing `private` or publishing: owner approves repository/license choices,
verify npm identity and scope permission, pin the release commit and supported
backend contracts, rerun checks, inspect the artifact/integrity and publish the
exact reviewed candidate under `alpha`. Never commit tokens or bypass a failed
registry authorization check. Backend scorer/keys remain private.

The private application issue #1377 tracks the deployment/contract matrix and full
evidence. Production capacity and arbitrary-provider behavior are not implied by
passing local fixtures. The package contains no detector engine or executable
remote policies.
