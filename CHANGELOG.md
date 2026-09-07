# Changelog

All notable changes to `drizzle-spanner` are recorded here. Both packages in
this repository version and release in lockstep from a single `v<version>`
tag; see [RELEASING.md](RELEASING.md).

## [0.2.0](https://github.com/brandhaug/drizzle-spanner/compare/v0.1.0...v0.2.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* audited public API surfaces; internals move to drizzle-spanner/internal

### Features

* bufferedMutations transaction mode ([fd574a8](https://github.com/brandhaug/drizzle-spanner/commit/fd574a84beff263d5edd717546d44b8c35765274))
* check the interleave PK prefix order at compile time ([#22](https://github.com/brandhaug/drizzle-spanner/issues/22)) ([4e2f504](https://github.com/brandhaug/drizzle-spanner/commit/4e2f5048b3bc8abacba2133b0333dd67224ba682))
* dialect, query builders, session, database and drizzle() entry ([e854477](https://github.com/brandhaug/drizzle-spanner/commit/e8544777e293dc020900c2d62f36489060143bbb))
* **examples:** basic-crud and interleaved-rqb, verified on the emulator in CI ([dd8e487](https://github.com/brandhaug/drizzle-spanner/commit/dd8e487d0587be61a915c78ea9f77436e19b65db))
* **kit:** pull, push and the CLI ([b51a79d](https://github.com/brandhaug/drizzle-spanner/commit/b51a79d66b87e43598a20b4a98675066ce280888))
* **kit:** scaffold drizzle-spanner-kit workspace package ([8140465](https://github.com/brandhaug/drizzle-spanner/commit/8140465fbb1dfaae296469378d6c6cf87e5b0da8))
* **kit:** snapshot differ, GoogleSQL DDL generator and generate command ([c30f9ab](https://github.com/brandhaug/drizzle-spanner/commit/c30f9abef22346c34ebdcd3873f3704b35b264f3))
* **kit:** snapshot serializer for the v8 spanner snapshot format ([c3c8a7d](https://github.com/brandhaug/drizzle-spanner/commit/c3c8a7dffa8f907f126ba6d79e674ce4e17fb10e))
* migrate — runtime migrator subpath and kit command ([5bced56](https://github.com/brandhaug/drizzle-spanner/commit/5bced561c56a238b490cadf968dc984335c44aa8))
* relational queries via correlated ARRAY(SELECT AS STRUCT) subqueries ([708c513](https://github.com/brandhaug/drizzle-spanner/commit/708c513d9e68f9fd64e931e4a236eef99185539c))
* schema layer — spannerTable, column builders, extra-config builders ([f21472b](https://github.com/brandhaug/drizzle-spanner/commit/f21472b7863b67967ff2dd6694c10e2dc64ce313))
* **schema:** foreignKey() and check() extra-config builders ([9d1accb](https://github.com/brandhaug/drizzle-spanner/commit/9d1accb693cc63ccc39dd13498c7e8fbe0bffdb0))
* transaction options, read-only transactions, and single-use stale reads ([91c6e48](https://github.com/brandhaug/drizzle-spanner/commit/91c6e48d461bbeebadc1bbef658b853d66a359f9))
* upsert via INSERT OR UPDATE / INSERT OR IGNORE (ADR 0002) ([3cec173](https://github.com/brandhaug/drizzle-spanner/commit/3cec1733dbeffd55390a05ea49437a7b9e8e5dda))


### Bug Fixes

* erase query-base to select type import to break ESM init cycle ([#42](https://github.com/brandhaug/drizzle-spanner/issues/42)) ([ae145f3](https://github.com/brandhaug/drizzle-spanner/commit/ae145f38611261faf5cb61ad484d12eaef84f12e))
* **kit:** print the DDL plan when push runs with --yes ([70774d8](https://github.com/brandhaug/drizzle-spanner/commit/70774d828e5f24796371610b6320a875475f99a3))
* **kit:** render TOKENLIST generated columns as HIDDEN ([2e52c8c](https://github.com/brandhaug/drizzle-spanner/commit/2e52c8cf9b5b16290165fd2d5a97679b4fc769f5))
* preserve query semantics and schema migration integrity ([#58](https://github.com/brandhaug/drizzle-spanner/issues/58)) ([b14faf3](https://github.com/brandhaug/drizzle-spanner/commit/b14faf3e0efb4a755735fde48cbcc914ce1ddf7e))
* **security:** override vulnerable transitive deps and finish drizzle-orm rc.4 migration ([#37](https://github.com/brandhaug/drizzle-spanner/issues/37)) ([4a36475](https://github.com/brandhaug/drizzle-spanner/commit/4a36475bf2b2b80ef85e13180aaff7033dd4ca3f))
* **test:** ignore a stopped test container masquerading as an external emulator under bun ([7974f94](https://github.com/brandhaug/drizzle-spanner/commit/7974f940759e1f8b350662ff2b9575abd6cb6127))


### Documentation

* contributing guide, security policy, issue templates and README gaps ([c2fbf19](https://github.com/brandhaug/drizzle-spanner/commit/c2fbf19820416ff70004fcc22a612ba200d15052))
* **spec:** fix interleaved example and document shipped kit behavior ([a268636](https://github.com/brandhaug/drizzle-spanner/commit/a268636887c6ee08f08ec49df336180c8ae4cf9b))


### Miscellaneous

* align tooling with canonical setup ([#40](https://github.com/brandhaug/drizzle-spanner/issues/40)) ([a793302](https://github.com/brandhaug/drizzle-spanner/commit/a793302fd2b9e01859b140f9d17d51674c18e768))
* **deps:** bump @google-cloud/spanner from 8.10.0 to 8.11.0 ([#34](https://github.com/brandhaug/drizzle-spanner/issues/34)) ([9689cd4](https://github.com/brandhaug/drizzle-spanner/commit/9689cd46bb2d821efde36cb4f1a03212d70a10f7))
* **deps:** bump @types/node from 24.13.3 to 26.2.0 ([#25](https://github.com/brandhaug/drizzle-spanner/issues/25)) ([c93c596](https://github.com/brandhaug/drizzle-spanner/commit/c93c5961d3c312c17ae68fa570da7b0dbaad9ec5))
* **deps:** bump @types/node from 26.2.0 to 26.3.0 ([#43](https://github.com/brandhaug/drizzle-spanner/issues/43)) ([07a2d1e](https://github.com/brandhaug/drizzle-spanner/commit/07a2d1eb862b4d2d0034b94b29b7843f6b184f50))
* **deps:** bump @types/node from 26.3.0 to 26.4.0 ([#45](https://github.com/brandhaug/drizzle-spanner/issues/45)) ([4482332](https://github.com/brandhaug/drizzle-spanner/commit/4482332ae9f873173191651f0bce261b9bbdf6b1))
* **deps:** bump @types/node from 26.4.0 to 26.4.1 ([#53](https://github.com/brandhaug/drizzle-spanner/issues/53)) ([1d5d69a](https://github.com/brandhaug/drizzle-spanner/commit/1d5d69a51140e0c636503a04781a3073fc5999f7))
* **deps:** bump drizzle-orm from 1.0.0-beta.22 to 1.0.0-rc.4 ([#26](https://github.com/brandhaug/drizzle-spanner/issues/26)) ([7466a93](https://github.com/brandhaug/drizzle-spanner/commit/7466a935343ee1adebc13f4ba1d4c9f8f463c82f))
* **deps:** bump lint-staged from 17.2.0 to 17.3.0 ([#27](https://github.com/brandhaug/drizzle-spanner/issues/27)) ([c423577](https://github.com/brandhaug/drizzle-spanner/commit/c4235773f4b0ad05e391c6a2723976436b7f1f65))
* **deps:** bump lint-staged from 17.3.0 to 17.4.1 ([#49](https://github.com/brandhaug/drizzle-spanner/issues/49)) ([9d07a9a](https://github.com/brandhaug/drizzle-spanner/commit/9d07a9a3ac22727cbfd371d830fafcd8a4b0ce7d))
* **deps:** bump oxfmt from 0.57.0 to 0.64.0 ([#28](https://github.com/brandhaug/drizzle-spanner/issues/28)) ([e625a25](https://github.com/brandhaug/drizzle-spanner/commit/e625a25405778a712da530d5ed991969c879256a))
* **deps:** bump oxfmt from 0.64.0 to 0.65.0 ([#38](https://github.com/brandhaug/drizzle-spanner/issues/38)) ([27b7863](https://github.com/brandhaug/drizzle-spanner/commit/27b7863b12b0941df0446e66e9d9ee2902a4fd7e))
* **deps:** bump oxfmt from 0.65.0 to 0.66.0 ([#54](https://github.com/brandhaug/drizzle-spanner/issues/54)) ([c247f6e](https://github.com/brandhaug/drizzle-spanner/commit/c247f6eba67f1fb093e1a62d3d6d3c5e4ab35f4c))
* **deps:** bump oxlint from 1.76.0 to 1.79.0 ([#29](https://github.com/brandhaug/drizzle-spanner/issues/29)) ([905fece](https://github.com/brandhaug/drizzle-spanner/commit/905fece55d9d681c0538e2144a276e85a83a8b1f))
* **deps:** bump oxlint from 1.79.0 to 1.80.0 ([#39](https://github.com/brandhaug/drizzle-spanner/issues/39)) ([4f8e0e6](https://github.com/brandhaug/drizzle-spanner/commit/4f8e0e64c1695da2ae069b19d41f7ff2800a26a0))
* **deps:** bump oxlint from 1.80.0 to 1.81.0 ([#55](https://github.com/brandhaug/drizzle-spanner/issues/55)) ([fd87119](https://github.com/brandhaug/drizzle-spanner/commit/fd87119b0050c6e6f570f75e1b5945dbda3d3690))
* **deps:** bump testcontainers from 11.14.0 to 12.1.0 ([#30](https://github.com/brandhaug/drizzle-spanner/issues/30)) ([121f8d5](https://github.com/brandhaug/drizzle-spanner/commit/121f8d5794dfcbc04c156ad25e701e51c0a4ae2c))
* **deps:** bump typescript from 5.9.3 to 7.0.2 ([#31](https://github.com/brandhaug/drizzle-spanner/issues/31)) ([05e8d77](https://github.com/brandhaug/drizzle-spanner/commit/05e8d77bbef29113b24fb19de217c25b92a87331))
* **deps:** bump ultracite from 7.10.6 to 7.10.7 ([#46](https://github.com/brandhaug/drizzle-spanner/issues/46)) ([d9f5f4b](https://github.com/brandhaug/drizzle-spanner/commit/d9f5f4ba051e8c4006735307a761c0df2da7760c))
* **deps:** bump vitest from 3.2.7 to 4.1.11 ([#32](https://github.com/brandhaug/drizzle-spanner/issues/32)) ([e44b08c](https://github.com/brandhaug/drizzle-spanner/commit/e44b08c962813b1944563ebfb3b5e8d8f685df5a))
* enable strict oxlint rules and fix violations ([#41](https://github.com/brandhaug/drizzle-spanner/issues/41)) ([1ece432](https://github.com/brandhaug/drizzle-spanner/commit/1ece432f42d41283cc57d81e7392bd273641c0d9))
* **release:** package hygiene, dry-run release flow and lockstep versioning ([e25c6a2](https://github.com/brandhaug/drizzle-spanner/commit/e25c6a2fd5918307d24b3e81730a2dcc6e5262e4))
* remove dead code and unused dependencies surfaced by fallow ([#51](https://github.com/brandhaug/drizzle-spanner/issues/51)) ([f7c9094](https://github.com/brandhaug/drizzle-spanner/commit/f7c90947d4c24f7b5d8266ad999628ad83e4c7ab))
* scaffold package with emulator environment and tooling ([5c69cf4](https://github.com/brandhaug/drizzle-spanner/commit/5c69cf476eaa5925e7c6d0073b43c8247e4cada2))
* **tooling:** replace ESLint with oxlint, add oxfmt and a pre-commit hook ([#23](https://github.com/brandhaug/drizzle-spanner/issues/23)) ([b95e595](https://github.com/brandhaug/drizzle-spanner/commit/b95e595402c5a77d5f9d34526dc2fe0e4057b939))
* update main branch references to master ([559994b](https://github.com/brandhaug/drizzle-spanner/commit/559994bbf2d465333a618cda6f073e31f65d4c54))
* upgrade bun to 1.4.2 ([#56](https://github.com/brandhaug/drizzle-spanner/issues/56)) ([c3398c1](https://github.com/brandhaug/drizzle-spanner/commit/c3398c1655f7ad4207d2d0598585f31c28838b2d))


### Code Refactoring

* apply code-review fixes across standards and spec axes ([8cb69f6](https://github.com/brandhaug/drizzle-spanner/commit/8cb69f679260d1ee3f45bff607370e39325a699b))
* apply second code-review pass across standards and spec axes ([2192a04](https://github.com/brandhaug/drizzle-spanner/commit/2192a04f9f1e91956421448ff6fd46586cc3fd82))
* apply third code-review pass across standards and spec axes ([788bd7c](https://github.com/brandhaug/drizzle-spanner/commit/788bd7c5300a1eed535ae081a1efcbb1d1695f26))
* audited public API surfaces; internals move to drizzle-spanner/internal ([5461ee1](https://github.com/brandhaug/drizzle-spanner/commit/5461ee1a603e9f07d8cc525676a6e5051fc69a7c))
* codebase-wide deslop cleanup ([#21](https://github.com/brandhaug/drizzle-spanner/issues/21)) ([c80cde6](https://github.com/brandhaug/drizzle-spanner/commit/c80cde6072633baef17efdd5228f9267a82e932d))
* drop dead migrationHash helper from the runtime migrator ([0026b30](https://github.com/brandhaug/drizzle-spanner/commit/0026b30c3a57bbcf9ad76e15964b8be31fa5f509))
* drop unused isAborted helper ([595f01b](https://github.com/brandhaug/drizzle-spanner/commit/595f01b58553036e273c3ae6d60fd412f0e8b1d8))
* **kit:** record rename journal entries as {from, to} pairs ([ba1b480](https://github.com/brandhaug/drizzle-spanner/commit/ba1b4806f2d093dd283680255bbc03ff1c02e790))

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
