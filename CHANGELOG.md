# Changelog

All notable changes to `drizzle-spanner` are recorded here. Both packages in
this repository version and release in lockstep from a single `v<version>`
tag; see [RELEASING.md](RELEASING.md).

## [0.1.2](https://github.com/brandhaug/drizzle-spanner/compare/v0.1.1...v0.1.2) (2026-09-26)


### Miscellaneous

* **deps:** bump @types/node from 26.6.1 to 26.6.2 ([#76](https://github.com/brandhaug/drizzle-spanner/issues/76)) ([9328a58](https://github.com/brandhaug/drizzle-spanner/commit/9328a58e43298ecac5b7a6c0a5eba0a672afd63a))
* **deps:** bump oxlint from 1.83.0 to 1.85.0 ([#79](https://github.com/brandhaug/drizzle-spanner/issues/79)) ([4f0cdc2](https://github.com/brandhaug/drizzle-spanner/commit/4f0cdc2f5fa62a1c3c6c8a2aed02553a493c5873))

## [0.1.1](https://github.com/brandhaug/drizzle-spanner/compare/v0.1.0...v0.1.1) (2026-09-21)


### Miscellaneous

* **deps:** bump @google-cloud/spanner from 8.11.0 to 8.12.0 ([#69](https://github.com/brandhaug/drizzle-spanner/issues/69)) ([08c7b23](https://github.com/brandhaug/drizzle-spanner/commit/08c7b236d517ff02f74b3301ce0abd135ef49d1b))
* **deps:** bump @types/node from 26.4.1 to 26.6.1 ([#71](https://github.com/brandhaug/drizzle-spanner/issues/71)) ([2367dd3](https://github.com/brandhaug/drizzle-spanner/commit/2367dd3afe96b37631a8158edb6e62feb0cb6351))
* **deps:** bump lint-staged from 17.4.1 to 17.5.0 ([#62](https://github.com/brandhaug/drizzle-spanner/issues/62)) ([12482cf](https://github.com/brandhaug/drizzle-spanner/commit/12482cfe93b7987f2a3cea056de40c98b9eb84ce))
* **deps:** bump lint-staged from 17.5.0 to 17.5.1 ([#68](https://github.com/brandhaug/drizzle-spanner/issues/68)) ([d79b358](https://github.com/brandhaug/drizzle-spanner/commit/d79b3586550b74e177e2d5e0554a8c753690de03))
* **deps:** bump oxfmt from 0.66.0 to 0.67.0 ([#64](https://github.com/brandhaug/drizzle-spanner/issues/64)) ([9310ab4](https://github.com/brandhaug/drizzle-spanner/commit/9310ab4dc19667a6c7e09a1209d1550466b2b620))
* **deps:** bump oxfmt from 0.67.0 to 0.68.0 ([#72](https://github.com/brandhaug/drizzle-spanner/issues/72)) ([c43f219](https://github.com/brandhaug/drizzle-spanner/commit/c43f21970e0bca2f24588fc6aaed06ade0981c74))
* **deps:** bump oxlint from 1.81.0 to 1.82.0 ([#65](https://github.com/brandhaug/drizzle-spanner/issues/65)) ([d1f77b4](https://github.com/brandhaug/drizzle-spanner/commit/d1f77b4f11f9ad0fc3f74e26bdb420c8b4653a7c))
* **deps:** bump oxlint from 1.82.0 to 1.83.0 ([#73](https://github.com/brandhaug/drizzle-spanner/issues/73)) ([f0bd084](https://github.com/brandhaug/drizzle-spanner/commit/f0bd084f5197c85cd44b2210d8d001fd508c5ec7))
* **deps:** bump oxlint-tsgolint from 7.0.2001 to 7.0.2002 ([#75](https://github.com/brandhaug/drizzle-spanner/issues/75)) ([a57f92d](https://github.com/brandhaug/drizzle-spanner/commit/a57f92d8a945e9463ff8360cd57fb94de5765764))
* **deps:** bump ultracite from 7.10.7 to 7.11.0 ([#57](https://github.com/brandhaug/drizzle-spanner/issues/57)) ([0c2f790](https://github.com/brandhaug/drizzle-spanner/commit/0c2f7903d44625e1018739e4b831b3cc1c7d6f17))
* **deps:** bump ultracite from 7.11.0 to 7.11.1 ([#67](https://github.com/brandhaug/drizzle-spanner/issues/67)) ([2d0094a](https://github.com/brandhaug/drizzle-spanner/commit/2d0094a3325e0dcea2734ab87e4ee908df06710b))
* **deps:** bump ultracite from 7.11.1 to 7.12.0 ([#74](https://github.com/brandhaug/drizzle-spanner/issues/74)) ([2622de4](https://github.com/brandhaug/drizzle-spanner/commit/2622de49ca9ef0af9b56645859546508adb955c5))

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
