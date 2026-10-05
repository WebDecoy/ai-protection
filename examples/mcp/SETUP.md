# Reviewable MCP setup (source preview)

This command scaffolds a handler for a selected Node TypeScript ESM options module.
It is available from this SDK source checkout, not an npm binary. It does not
install dependencies, rewrite an existing server, run project code or prove a live
integration. Next.js, Go, stateful MCP and automatic framework detection are not
supported by this command.

Prepare an existing options module that exports `mcpOptions` typed as
`ProtectedMCPOptions` from `@webdecoy/ai-protection/mcp`. Use the [MCP integration
contract](../../MCP.md): resource URL ending in `/mcp`, trusted authentication,
explicit tool validation and authorization, and customer-owned tool callbacks.
Configure shared controls and secrets in your server environment as needed.

From this SDK source checkout:

```sh
node scripts/setup-mcp.mjs plan /absolute/path/to/app src/mcp-options.ts
node scripts/setup-mcp.mjs apply /absolute/path/to/app src/mcp-options.ts
node scripts/setup-mcp.mjs rollback /absolute/path/to/app src/mcp-options.ts
```

`plan` reads bounded package/source files and prints a proposed addition plus
metadata checks. Review it first. `apply` requires exact tested dependency pins
(`@webdecoy/ai-protection@0.1.0-alpha.16`, MCP SDK `1.31.0`) and `type: module`.
Other dependency ranges are unverified, not automatically upgraded. It creates
`webdecoy-mcp.ts` beside the selected module using exclusive creation. Repeating
apply is a no-op when the contents match; an existing different file is untouched.
Rollback removes only a byte-identical generated file; it refuses edited content.
These commands operate on a project at rest; do not concurrently edit or rename
its directories during an apply/rollback operation.

Compile with your own build, then connect the exported `protectedMCPHandler` only
to the intended `/mcp` route. The command cannot verify the selected module's
export or route wiring by reading package metadata. It creates no listening server
and does not remove alternate handlers. Remove your manual route wiring before
rollback. Broad installation, runtime diagnostics and route edits remain #1408.

## Interpretation of results

`configured` means only that package metadata matches the tested versions.
`coverage: not_verified` is intentional. Authentication, ownership, credentials,
backend compatibility, effective modes, report delivery, request correlation and
callback behavior remain unverified. Browser receipts are not required for machine
callers; model budget reporting is not verified by a tools-only scaffold.

No secrets or source contents are printed. Follow the remediation fields, compile,
and run an owned synthetic workload before claiming protection. The app repository's
MCP/PostgreSQL acceptance and this example's official-client tests demonstrate
supported behavior in fixtures; they do not validate your deployment automatically.
