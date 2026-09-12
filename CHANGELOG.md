# Changelog

All notable changes to `drizzle-spanner` are recorded here. Both packages in
this repository version and release in lockstep from a single `v<version>`
tag; see [RELEASING.md](RELEASING.md).

## [0.1.1](https://github.com/brandhaug/drizzle-spanner/compare/v0.1.0...v0.1.1) (2026-09-12)


### Miscellaneous

* **deps:** bump lint-staged from 17.4.1 to 17.5.0 ([#62](https://github.com/brandhaug/drizzle-spanner/issues/62)) ([12482cf](https://github.com/brandhaug/drizzle-spanner/commit/12482cfe93b7987f2a3cea056de40c98b9eb84ce))
* **deps:** bump oxlint from 1.81.0 to 1.82.0 ([#65](https://github.com/brandhaug/drizzle-spanner/issues/65)) ([d1f77b4](https://github.com/brandhaug/drizzle-spanner/commit/d1f77b4f11f9ad0fc3f74e26bdb420c8b4653a7c))
* **deps:** bump ultracite from 7.10.7 to 7.11.0 ([#57](https://github.com/brandhaug/drizzle-spanner/issues/57)) ([0c2f790](https://github.com/brandhaug/drizzle-spanner/commit/0c2f7903d44625e1018739e4b831b3cc1c7d6f17))

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
