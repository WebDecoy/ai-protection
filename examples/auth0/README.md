# Auth0 access tokens → protected actions (development example)

This source-only example verifies Auth0 RS256 custom-API access tokens with `jose`
and maps authenticated identity into the Alpha action boundary. It adds no
runtime dependency to the core SDK.

```sh
cd examples/auth0
npm ci
npm test
```

Tests generate an ephemeral signing key and Auth0-shaped tokens and stub only the
JWKS transport. They exercise actual cryptographic verification and action dispatch.
They do not log in to or provision a live Auth0 tenant.

## Connect your API

Configure an Auth0 custom API with RS256 and an identifier dedicated to your API.
Obtain an access token using your application's existing authorized flow. Do not
use an ID token or an Auth0 Management API token. Configure issuer/audience from
trusted server settings; the token cannot choose its issuer or JWKS URL.

```js
import {createAuth0Authenticator} from './authenticate.mjs';
import {createActionProtection} from '../../actions.mjs';

const authenticate = createAuth0Authenticator({
  issuer: process.env.AUTH0_ISSUER, // https://your-tenant.auth0.com/
  audience: process.env.AUTH0_AUDIENCE,
  resolveTenant: async ({issuer, subject, organizationId}, {signal}) => {
    // Your application's database lookup, checking current membership.
    // Return its canonical tenant ID or null. Never accept a requested body tenant.
    return lookupActiveMembership({issuer, subject, organizationId, signal});
  },
});
const guard = createActionProtection({
  policyVersion: 'records_v1', authenticate,
  actions: yourServerActionRegistry,
});
// Inside the server route; request is the original Fetch Request:
// await guard.run('records.read', validatedArguments, request, {signal: request.signal});
```

`lookupActiveMembership` and `yourServerActionRegistry` are application code, not
SDK exports. A signed `org_id` must still map to an allowed application membership.
The credential subject and OAuth client (`azp`) stay separate. No user delegation,
verified agent signer, token introspection or immediate revocation guarantee is
inferred. Scope checks happen at each registered action. The example supports
Auth0's `scope` string and RS256 profile; other token profiles need separate review.

The original bearer token stays in the application verifier and is never forwarded
to WebDecoy, the JWKS endpoint, or tool callbacks. JWKS uses a fixed HTTPS URL,
no redirects, a 1-second fetch timeout, 64 KiB maximum, and jose's bounded refresh
cache/cooldown. The outer action admission deadline prevents late verification from
starting execution. `fetcher` is a trusted test/transport injection, never request
configuration. Return generic authentication errors; do not expose verification
exceptions or tokens in responses/logs.

The [MCP example](../mcp/README.md) uses this verifier with the public MCP handler,
protected-resource discovery, HTTP challenges and per-tool scope checks. Its
real-client tests currently use locally signed tokens and a fixture JWKS transport;
a live customer-owned Auth0 token/JWKS validation remains a separate verification step.

The supported profile has no delegation chain. Tokens containing `act` or `may_act`
are rejected before tenant lookup; accepting delegation requires a separately
implemented and reviewed actor/subject authorization contract. Arbitrary `agent_id`
claims and agent headers never establish a verified signer. Subject, client,
organization and scopes are bounded before reaching application membership code.
See the [caller identity contract](../../CALLER_IDENTITY.md).

References:
- [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)
- [Auth0 organization token checks](https://auth0.com/docs/manage-users/organizations/using-tokens)
- [jose remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)
