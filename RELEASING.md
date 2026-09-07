# Releasing

Both `drizzle-spanner` and `drizzle-spanner-kit` release together under one
`v<version>` tag. Versions stay below 1.0 until Drizzle ORM v1 is stable.

## Automated releases

The setup follows `brandhaug/effectful-better-auth`:

1. Conventional Commits on `master` update a release-please PR through
   `.github/workflows/release.yml`, using the repository's `CI_PAT` secret.
2. The PR updates the root version and changelog, the CLI package version,
   and `.release-please-manifest.json`.
3. Merging the release PR creates a GitHub release and tag. The publish job
   checks versions, lint, types, tests, builds, and package contents.
4. The job publishes the adapter, then the CLI, with npm provenance through
   the GitHub `release` environment. Each package needs its own npm trusted
   publisher configuration. No npm token is stored in GitHub.

The root `CHANGELOG.md` contains release notes for both packages. Publishing
copies it into the CLI package. The CLI's checked-in changelog preserves its
initial release notes.

Pre-1.0 releases use npm's `latest` tag because there is no stable line yet.
To retry a partial release, dispatch the Release workflow on `master` with
`force-publish` enabled. Already-published versions are skipped; other registry
errors stop the job.

## First publication

A maintainer publishes the initial 0.1.0 packages using their npm account.
Build the adapter before building the CLI, which depends on its output:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun install
bun run --cwd packages/drizzle-spanner-kit build
bun scripts/release-check.ts v0.1.0
bun run check:types
bun run check:pack
npm publish --access public
npm publish --access public --workspace drizzle-spanner-kit
```

After the packages exist, configure a GitHub Actions trusted publisher in
**each package's** npm settings:

- Organization or user: `brandhaug`
- Repository: `drizzle-spanner`
- Workflow filename: `release.yml`
- Environment: `release`

See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
Create the initial `v0.1.0` GitHub release at the published commit so that
release-please starts subsequent changelogs from that release.
