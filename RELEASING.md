# Releasing @webdecoy/ai-protection

Initial release is `0.1.0-alpha.1`, on the `alpha` dist-tag. Do not label this
production-ready or change `latest` until the pilot is validated.

## First publication

A maintainer with publish rights in the npm `@webdecoy` organization must log in
interactively (`npm login`). Do not commit tokens or paste them into issues.
The npm scope's ownership and access are prerequisites; an unused package name
does not establish permission to publish it.

From a clean checkout of the reviewed commit:

```sh
npm ci
npm test
npm run check:package
npm publish --dry-run --access public --tag alpha
npm publish --access public --tag alpha
```

The publish command runs the test/package checks again. First publication may
require npm's browser/2FA interaction. Verify:

```sh
npm view @webdecoy/ai-protection@alpha version dist-tags
```

After successful publication, update the README's pending-publication text. Do
not claim that the registry install works before the package actually exists.

## Subsequent releases with GitHub Actions

Configure an npm trusted publisher for:

- GitHub owner: `WebDecoy`
- Repository: `ai-protection`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: direct `npm publish`

The workflow runs only when a release is published, verifies that its tag matches
`package.json`, and publishes with the `alpha` dist-tag. It uses GitHub OIDC;
no long-lived npm publish secret is needed. Configure the `npm` GitHub environment
with the appropriate maintainer protection before use. Do not attach publisher
permissions to pull-request jobs.

For each release, update version/lockfile and release notes, ensure CI passes,
then publish a GitHub prerelease named `v<VERSION>` from the reviewed commit.
The current workflow intentionally accepts only alpha versions.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
