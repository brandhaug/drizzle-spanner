# Changelog

All notable changes to `drizzle-spanner` are recorded here. Both packages in
this repository version and release in lockstep from a single `v<version>`
tag; see [RELEASING.md](RELEASING.md).

## 0.1.0

Initial release.

- Spanner GoogleSQL dialect for Drizzle ORM v1 beta: `spannerTable`, the full
  column-builder set, `drizzle()` entry point, and `drizzle.mock()`.
- Read-write transactions with automatic `ABORTED` retries, read-only
  transactions with staleness bounds, single-use stale reads via
  `withStaleness`, and a `bufferedMutations` transaction mode.
- Upsert via `INSERT OR UPDATE` / `INSERT OR IGNORE`, `.returning()` via
  `THEN RETURN`.
- Relational queries compiled to correlated `ARRAY(SELECT AS STRUCT)`
  subqueries.
- Typed `SpannerError` taxonomy; error messages carry parameter names, never
  values.
- Runtime migrator at `drizzle-spanner/migrator`.
