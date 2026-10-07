# Clean MCP installation fixture

A local-only TypeScript Node ESM app for validating the source setup commands.
It uses synthetic credentials, in-memory records and independent callback counters.
It has no model client, provider credentials or paid fallback. Do not deploy this
fixture publicly or use its tokens for real authentication.

From the SDK source checkout, copy it to a fresh directory, then install its pinned
packages. Substitute your own fresh destination below:

```sh
cp -R examples/mcp-install /tmp/my-mcp-sample
npm install --prefix /tmp/my-mcp-sample --ignore-scripts
node scripts/setup-mcp.mjs plan /tmp/my-mcp-sample src/options.ts
node scripts/setup-mcp.mjs apply /tmp/my-mcp-sample src/options.ts
node scripts/wire-mcp-route.mjs plan /tmp/my-mcp-sample src/server.ts src/webdecoy-mcp.ts
node scripts/wire-mcp-route.mjs apply /tmp/my-mcp-sample src/server.ts src/webdecoy-mcp.ts
npm run build --prefix /tmp/my-mcp-sample
npm start --prefix /tmp/my-mcp-sample
```

In another terminal in the SDK checkout:

```sh
MCP_RESOURCE=http://127.0.0.1:8093/mcp MCP_TEST_TOKEN=owned-a node scripts/verify-mcp-route.mjs
```

`owned-a` and `owned-b` are deliberately public fixture tokens mapped to two
synthetic tenants. `read` returns only a matching tenant's record; `admin` always
denies; `wait` blocks until the request is cancelled. Avoid calling `wait` from a
client that cannot cancel. `/health` remains outside the protected MCP route.
The route probe only initializes/pings/lists; it does not call these tools.

To run the allowed, forbidden, cross-tenant and cancellation calls as well, use
the sample plan (synthetic fixture tokens only):

```sh
node scripts/doctor-mcp.mjs detect /tmp/my-mcp-sample
MCP_TEST_TOKEN_A=owned-a MCP_TEST_TOKEN_B=owned-b node scripts/doctor-mcp.mjs check examples/mcp-install/doctor-plan.json
```

Repeat the apply commands to verify no-op behavior. To remove the integration,
stop the server, rollback wiring first, then the handler, clean the build directory
and rebuild/restart. An already-running process does not change when files change.

```sh
node scripts/wire-mcp-route.mjs rollback /tmp/my-mcp-sample src/server.ts src/webdecoy-mcp.ts
node scripts/setup-mcp.mjs rollback /tmp/my-mcp-sample src/options.ts
```

## Automated acceptance

From the SDK source checkout with dependencies installed:

```sh
node --test test/mcp-install-flow.test.mjs
```

The test copies this app into a temporary directory, uses the setup/wiring APIs,
compiles it, opens an ephemeral loopback port and runs the official MCP client.
It verifies allowed reads, permission and tenant denial, forged arguments,
independent callback counts, cancellation, unrelated health routing, repeat apply,
rollback source restoration and compilation after rollback. Timeout: 20 seconds.
Temporary servers and files are cleaned up.

Ordinary tests use the source SDK; package-artifact validation repeats the flow
against the packed SDK. `WEBDECOY_INSTALL_SDK_ROOT` can point to an absolute freshly
installed SDK directory to verify registry compatibility. This is test configuration,
not an installer option.

This fixture does not configure shared runtime limits, cloud credentials, browser
receipts or model budgets. Those are unconfigured, not verified. Runtime outage and
work-accounting acceptance lives in the app repository's PostgreSQL workload. Full
onboarding still needs effective-control diagnostics and customer-bound evidence.
