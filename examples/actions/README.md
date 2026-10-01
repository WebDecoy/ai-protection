# Protected record actions (development preview)

Run `node examples/actions/records.mjs` from this source checkout. It performs one
permitted read, denies a cross-tenant read and an export, and rejects a forged
session. Independent counters assert exactly one read and zero exports. No paid
provider or WebDecoy credentials are needed.

The `/actions` API is unreleased. It is a local dispatch boundary, not an MCP
adapter or an identity provider. `authenticate` must call your existing server
session/token verifier; the example's in-memory sessions are only a fixture.
For OAuth, your verifier must validate issuer, audience/resource, expiry and
scopes before returning a `TrustedCaller`. Never construct one from tool arguments,
unsigned identity headers or an MCP session ID. A WebDecoy API key identifies the
integrator, not the caller of the action. `clientId` is the authenticated OAuth
client, not verified agent identity or delegated-user consent. Signer verification
and a concrete OAuth integration are follow-up work.

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
Shared operation allowances, streaming completion hooks, Go parity and MCP dispatch
are not implemented in this preview.

The optional local `onEvent` observer receives action ID, registered action name,
policy version, decision/reason and attempted/completed/unknown state. It receives
no raw caller/tenant/resource IDs, arguments, credentials or error messages. Keep
configured action and policy names free of customer data. Delivery is best effort,
capped at 100 outstanding observer calls; a hung observer drops subsequent events.
No hosted action dashboard/reporting is wired yet. Do not treat these events as a
complete audit trail or retry an action because an event is absent.
