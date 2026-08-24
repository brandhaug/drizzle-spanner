# drizzle-spanner

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commit & Release Conventions

- **All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/)**: `type(scope): subject`, where `type` is one of `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes.
- This convention is enforced by the **PR Gate** workflow (`.github/workflows/pr-gate.yml`), which fails any PR whose title does not conform.
- Releases are automated by [release-please](https://github.com/googleapis/release-please-action): merging Conventional Commits to `master` opens a release PR titled `chore(master): release ...`; merging it tags and publishes the release.
- `CLAUDE.md` is a symlink to this file so Claude Code reads the same conventions.
