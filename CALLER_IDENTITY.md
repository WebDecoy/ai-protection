# Caller identity in the Alpha action boundary

The application authenticates the original incoming request. WebDecoy validates
and copies the resulting `TrustedCaller` schema 1; it does not verify that
application's credentials itself. Node and Go accept the same core fields:

| Field | Meaning |
| --- | --- |
| subject / Subject | Credential subject established by application authentication |
| tenant / Tenant | Canonical application tenant after a current membership check |
| issuer / Issuer | Trusted identity namespace; never taken from an unverified token |
| authenticationMethod / AuthenticationMethod | Application-established method label |
| expiresAt / ExpiresAt | Credential expiry (Node Unix milliseconds; Go time.Time), rechecked before execution |
| scopes / Scopes | Authenticated permission inputs; application ownership checks remain required |
| clientId / ClientID | Optional OAuth client identity, distinct from credential subject |

Schema must be 1. Required strings are nonempty and reject control characters;
there are at most 64 scopes. Node limits identity strings to 512 UTF-16 code units;
Go limits them to 512 UTF-8 bytes. Use at most 512 UTF-8 bytes for portable context.
An absent Node clientId or empty Go ClientID means unavailable, never verified.
Scope duplicates cannot create extra privileges. Callers cannot supply a tenant,
subject or permission through tool arguments, MCP session IDs or agent headers.

## Verified, claimed and unavailable

“Authenticated” means verified by the customer's server integration. Hosted
`source: application_auth` evidence is an application report, not independent
WebDecoy verification. A valid token is not proof of a unique human or benign agent.
An OAuth client is not automatically the user represented by its subject.

Schema 1 has no delegation-chain or verified agent-signer field. Those capabilities
are unavailable; do not flatten an actor chain into the subject or use a claimed
agent name as authorization. The Auth0 example rejects `act` and `may_act`, and
ignores arbitrary agent identity labels. Applications needing delegated actor
policy must implement and review it before producing this core context. Signed
Web Bot Auth verification remains deferred. Unknown SDK input fields are not a
mechanism for extending trusted authority.

Authentication failure and explicit application permission denials remain effective
when WebDecoy is unavailable. A detector fail-open result never authenticates a
request. The Node MCP boundary is authenticated-only; it does not create anonymous
callers from missing credentials. Alternate unwrapped routes remain uncovered.

## Caller reporting, retention and rotation

Node caller reporting is opt-in (`sharedRuntime.reportCaller: true`). It emits an
HMAC-SHA256 pseudonym, not raw subject, tenant, issuer, client ID or scopes. Inputs
are length-framed UTF-8 strings: `webdecoy.actions.evidence.caller.v1`, lowercase
property UUID, issuer, tenant and subject, keyed by the server-owned subject secret.
OAuth client and network IP are deliberately absent: changing clients or sharing
an IP does not manufacture a new authenticated subject. Issuer/tenant/property
changes create distinct evidence identities. This emission is not currently a Go
or Python parity promise.

Use the same secret and canonical identity mapping across replicas. Changing the
secret or identity mapping creates new pseudonyms and can reset shared caller
allowance continuity. Existing caller pauses will not match the new pseudonym.
Rotate as an intentional application rollout: keep application authorization
active, reconcile any required limits/pauses using your private identity mapping,
and expect mixed identities while old replicas drain. Do not send raw identity to
WebDecoy to bridge the transition; there is no automatic alias/migration service.
A compromised secret should be rotated despite the continuity cost.

Hosted action evidence is retained for seven days; caller timelines scan at most
10,000 property reports and show at most 200 events. Missing evidence is unknown,
not proof of no activity. Saved pause state/audits and operator provider records
are separate records and do not expire with the evidence window. Expiring a pause
changes enforcement state; it does not delete the audit history. A new pseudonym
does not erase old retained records. Respect your own application identity mapping
retention/access controls and avoid logging bearer tokens or raw tool payloads.


## Shared conformance cases

`test/fixtures/caller-contract-v1.json` is mirrored in the Go SDK's
`testdata/caller-contract-v1.json`. Both suites dispatch the same 30 core caller
cases and assert exact allow/denial outcomes and zero execution on denial.
Coverage includes subject/issuer/method/tenant bounds, scope count, optional client,
expiry, Unicode within portable limits and forged identity in action arguments.
Language-native malformed Unicode is tested separately. This validates the shared
core contract, not OAuth provider issuance, signed-agent identity or parity of
optional runtime features. Language representation differences above stay explicit.

## Alpha scope decision: delegation and signers

Alpha supports an application-authenticated subject, canonical tenant, scopes and
optional OAuth client. It does not interpret token-exchange actor chains, establish
an agent brand's identity or issue credentials. Delegation and agent signer evidence
are **unavailable** in schema 1. A claimed label remains untrusted application data.
No additional verification boolean can turn that label into authority.

The Auth0 reference verifier rejects `act` and `may_act`; other application verifiers
must make the same scope decision explicitly. Existing scopes can restrict a
credential, but do not establish an actor chain. No scope, signer or client field
can override application membership or resource ownership. This is a product
boundary for Alpha, not a claim that delegated access is implemented.

Revisit actor-chain support for a concrete customer using token exchange. Required
work would include separate actor/subject identities, trusted issuer relationships,
chain bounds, audience restrictions, per-actor permissions, revocation semantics
and denial tests for substituted actors/tenants. Revisit signer evidence only with
a concrete signing protocol and original-request verification, replay protection
and key lifecycle. Both require a versioned contract and Node/Go conformance before
being advertised; adding optional display labels alone is insufficient.

Basis: [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html#section-4.1) distinguishes
actor identity from the top-level subject; it leaves deployment trust policy to the
implementation. [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)
requires signature/claims, target audience and permissions checks.
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
binds access tokens to the intended resource. These standards support the boundary;
they are not evidence that WebDecoy has implemented delegation or signer verification.
