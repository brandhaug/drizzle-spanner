# Contributing

The repository is an npm workspace: the root package is `drizzle-spanner`
(the ORM adapter) and `packages/drizzle-spanner-kit` is the migration CLI.
The build-ready design lives in
[docs/spec/drizzle-spanner.md](docs/spec/drizzle-spanner.md); architectural
decisions live in [docs/adr/](docs/adr/).

## Setup

Node >= 22.18 (the kit loads TypeScript configs through the runtime's native
TS support) and Docker (for the emulator-backed integration tests).

```bash
npm ci
npm run build
npm run build -w drizzle-spanner-kit
```

## Tests

| Command                        | What it runs                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `npm test`                     | Unit tests for both packages (SQL generation, no database)          |
| `npm run test:integration`     | Emulator integration tests via testcontainers (needs Docker)        |
| `npm run test:integration:bun` | The integration suite under Bun against an already-running emulator |
| `npm run lint`                 | oxlint over the workspace (`npm run lint:fix` applies fixes)        |
| `npm run format`               | oxfmt over the workspace (`npm run format:check` in CI)             |
| `npm run check`                | typecheck + lint + format check + unit tests                        |
| `npm run typecheck`            | `tsc --noEmit` over the whole workspace                             |
| `npm run check:types`          | `arethetypeswrong` against the packed tarballs                      |
| `npm run check:pack`           | `npm pack` contents match the dist-only whitelist                   |

Integration tests start one emulator container per test worker
(testcontainers manages the lifecycle; emulator state is in-memory, so
isolation is free). For an interactive dev loop against a long-lived
emulator:

```bash
npm run emulator:up      # docker compose: emulator on localhost:9010
npm run test:integration # picks up the running emulator
npm run emulator:down
```

Bun cannot manage per-file testcontainers in one process, so the Bun suite
expects a running emulator and `SPANNER_EMULATOR_HOST=localhost:9010`. See
[docs/emulator.md](docs/emulator.md) for what the emulator cannot do; those
paths run nightly against real Spanner (`.github/workflows/nightly-spanner.yml`).

## The lint rule for drizzle-orm imports

`.oxlintrc.json` restricts runtime imports to the drizzle-orm base
subpaths listed in the spec's package-layout section (`drizzle-orm/table`,
`drizzle-orm/session`, ...). Root imports and other dialects' modules
(`drizzle-orm/pg-core`, ...) are errors.

Why: drizzle-spanner follows the Gel pattern — it owns every dialect class
and extends only exported base modules. Importing another dialect's core or
an unexported path couples this package to drizzle internals that can change
in any beta, which is exactly the breakage the CI beta matrix exists to
catch. Other dialects' sources are reference reading only. If a new base
subpath is genuinely needed, add it to the spec's permitted list and the
oxlint config in the same PR.

## The beta-matrix policy

`.github/tested-versions.json` is the single source of truth for supported
`drizzle-orm` betas and tested runtimes. CI reads its matrices from that
file, and the README's tested-versions table is generated from it
(`node scripts/sync-tested-versions.ts`; CI fails on drift).

When drizzle releases a new beta in the supported range
(`>=1.0.0-beta.22 <1.0.0`):

1. Add the version to the `drizzle-orm` array in
   `.github/tested-versions.json`.
2. Run `node scripts/sync-tested-versions.ts` to regenerate the README table.
3. Open a PR. If the new beta breaks the adapter, CI fails loudly — that is
   the point (spec: a breaking beta must fail in CI, not in a user
   application). Fix the adapter in the same PR or track the incompatibility
   in an issue before the version is listed as supported.

## Commits and releases

Commits follow Conventional Commits (`feat:`, `fix:`, `test:`, `ci:`,
`docs:`, `chore:`; scope `kit` for the CLI package). Releases are lockstep
tags across both packages — see [RELEASING.md](RELEASING.md).
