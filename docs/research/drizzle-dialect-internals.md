# Drizzle v1 beta: dialect internals and extensibility

Research for issue #2. Examined packages: `drizzle-orm@1.0.0-beta.22` and `drizzle-kit@1.0.0-beta.22` from npm.

## Summary

- An external package can implement a new dialect. All runtime building blocks are exported.
- The exports map of `drizzle-orm` exposes every internal subpath. This includes each dialect module and each base module.
- Two blockers exist. Both are type-level or tooling-level. Neither blocks runtime code. See "Blockers".
- `drizzle-kit` does not support external dialects. Its dialect list is closed. A spanner package must ship its own migration tooling.

## How Drizzle composes a dialect

Each dialect is a set of parallel modules. The pattern is identical across `pg-core`, `mysql-core`, `sqlite-core`, `singlestore-core`, `gel-core`, `mssql-core`, and `cockroach-core`. The beta added `gel-core`, `mssql-core`, and `cockroach-core`. `gel-core` is the smallest complete template.

A dialect has these parts:

1. **Dialect / SQL builder** (`<x>-core/dialect.ts`). One class, for example `GelDialect`. It does not extend a shared base class. It implements `escapeName`, `escapeParam`, `escapeString`, `sqlToQuery`, `buildSelectQuery`, `buildInsertQuery`, `buildUpdateQuery`, `buildDeleteQuery`, and `buildRelationalQuery`. It satisfies the `BuildQueryConfig` contract from `drizzle-orm/sql`. `SQL.toQuery(config)` consumes that contract to render SQL text and parameters.
2. **Session** (`<x>-core/session.ts`). Abstract classes: `<X>Session`, `<X>PreparedQuery`, `<X>Transaction`. The prepared query implements the `PreparedQuery` interface from `drizzle-orm/session`. The session declares `prepareQuery`, `prepareRelationalQuery`, `execute`, and `transaction`. The transaction class extends the database class.
3. **Database** (`<x>-core/db.ts`). One class, for example `GelDatabase`. The constructor takes the dialect, the session, the relations, and the optional v1 schema. It exposes `select`, `insert`, `update`, `delete`, `execute`, `transaction`, `$with`, `$count`, and the `query` relational API.
4. **Table** (`<x>-core/table.ts`). `<X>Table` extends `Table` from `drizzle-orm/table`. A factory function, for example `gelTable`, builds columns from builders and attaches extra config (indexes, primary keys, foreign keys, checks).
5. **Column builders and columns** (`<x>-core/columns/*`). `<X>ColumnBuilder` extends `ColumnBuilder` from `drizzle-orm/column-builder`. `<X>Column` extends `Column` from `drizzle-orm/column`. Each database type gets one builder pair, for example `GelUuid` or `MySqlVarChar`. Columns map values with `mapFromDriverValue` and `mapToDriverValue`.
6. **Query builders** (`<x>-core/query-builders/*`). Select, insert, update, delete, and count. They extend `QueryPromise` from `drizzle-orm/query-promise`. They implement `RunnableQuery` and `SQLWrapper`. They use `TypedQueryBuilder` from `drizzle-orm/query-builders/query-builder`, `SelectionProxyHandler` from `drizzle-orm/selection-proxy`, and `Subquery` from `drizzle-orm/subquery`. They delegate SQL construction to the dialect class.
7. **Driver adapter** (top-level module, for example `drizzle-orm/gel`). It exports a `drizzle()` function. The function wires the client, the dialect, the session, and the database. It accepts `DrizzleConfig` from `drizzle-orm/utils` with `logger`, `casing`, `schema`, `relations`, and `cache`. It also exports a `drizzle.mock()` variant.
8. **Migrator** (per driver, for example `drizzle-orm/gel/migrator`). It reads migration files with `readMigrationFiles` from `drizzle-orm/migrator`. It applies them through the session.
9. **Constraint builders** (`<x>-core/indexes.ts`, `primary-keys.ts`, `foreign-keys.ts`, `unique-constraint.ts`, `checks.ts`). Optional per feature. Each is dialect-local code with no hidden base dependency.

Every class sets a `static readonly [entityKind]: string` marker. The `is()` helper from `drizzle-orm/entity` dispatches on this marker. Shared code checks base kinds such as `Table` and `Column`. Subclasses in an external package pass these checks.

## Can an external package build a dialect?

Yes. The exports map exposes all required base modules. Verified against `1.0.0-beta.22`:

- `drizzle-orm/entity`, `drizzle-orm/table`, `drizzle-orm/table.utils`, `drizzle-orm/column`, `drizzle-orm/column-builder` — exported.
- `drizzle-orm/sql`, `drizzle-orm/sql/sql`, `drizzle-orm/sql/expressions` — exported.
- `drizzle-orm/session`, `drizzle-orm/query-promise`, `drizzle-orm/runnable-query`, `drizzle-orm/query-builders/query-builder`, `drizzle-orm/query-builders/select.types`, `drizzle-orm/selection-proxy`, `drizzle-orm/subquery`, `drizzle-orm/alias`, `drizzle-orm/view-common` — exported.
- `drizzle-orm/relations`, `drizzle-orm/_relations`, `drizzle-orm/casing`, `drizzle-orm/utils`, `drizzle-orm/errors`, `drizzle-orm/logger`, `drizzle-orm/tracing`, `drizzle-orm/migrator`, `drizzle-orm/cache/core`, `drizzle-orm/cache/core/types` — exported.
- All dialect subpaths, for example `drizzle-orm/gel-core/dialect`, are also exported. A spanner package can read them as reference or subclass them.

No required runtime class is unexported.

## Blockers

These items are not exported or not extensible. Record for planning:

1. **`Dialect` type union is closed.** `drizzle-orm/column-builder` defines `type Dialect = 'pg' | 'mysql' | 'sqlite' | 'singlestore' | 'mssql' | 'common' | 'gel' | 'cockroach'`. The helper types `BuildColumn`, `BuildColumns`, `BuildExtraConfigColumns`, and `ChangeColumnTableName` map only these literals. There is no `'spanner'` branch. Effect: the spanner package cannot reuse these helper types with its own column classes. Workaround: define local equivalents (`BuildSpannerColumns`, `SpannerBuildColumn`) in the spanner package. This is copy work, not a hard block. The runtime is open: the base `TableConfig.dialect` field in `drizzle-orm/table` is typed `string`.
2. **`drizzle-kit` has a closed dialect list.** The config accepts only `postgresql`, `mysql`, `sqlite`, `turso`, `singlestore`, `gel`, `mssql`, `cockroach`, and `duckdb`. There is no plugin API. The programmatic exports (`drizzle-kit/api-postgres`, `api-mysql`, `api-sqlite`) cover only three dialects. Effect: no `generate`, `push`, `pull`, or `studio` for spanner. Workaround: ship hand-written SQL migrations plus a custom `migrate()` built on `readMigrationFiles` from `drizzle-orm/migrator`, or build a separate spanner-kit later.
3. **`QueryTypingsValue` is a closed union** (`'json' | 'decimal' | 'time' | 'timestamp' | 'uuid' | 'date' | 'none'`). Minor. Spanner param typing must fit these values or ignore typings.

## Beta changes that matter

- **Relations v2.** `defineRelations` in `drizzle-orm/relations` replaces the v1 API. `drizzle()` config takes a `relations` key. The v1 API moved to `drizzle-orm/_relations` and is deprecated. A new dialect must implement two paths: `Session.prepareRelationalQuery` and `Dialect.buildRelationalQuery`. The helpers `relationToSQL`, `relationsFilterToSQL`, `relationsOrderToSQL`, `relationExtrasToSQL`, and `mapRelationalRow` are exported from `drizzle-orm/relations`. The gel dialect shows the reference implementation.
- **Typed column data types.** `ColumnType` is now a constrained string, for example `'bigint int64'` or `'string uuid'`. Spanner builders must pick correct `dataType` strings. `INT64` maps well to `'bigint int64'` or `'number int53'`.
- **Casing support.** Dialect constructors take `{ casing?: Casing }`. The dialect owns a `CasingCache` from `drizzle-orm/casing`.
- **Cache layer.** Sessions and prepared queries thread an optional `Cache` from `drizzle-orm/cache/core` plus query metadata. Copy this plumbing from gel-core.
- **Table extra config.** The third argument of the table factory now returns an array. The object form is deprecated.
- **New dialects as templates.** The beta added gel, mssql, and cockroach cores. Gel is the smallest. Cockroach shows a fork of pg-core with type changes.
- **drizzle-kit v1.** Snapshot and journal formats changed. The kit dialect list grew but stays closed (see Blockers).

## Minimum deliverables for a drizzle-spanner package

| # | Item | Kind | Extends / implements | Import path for the base |
|---|------|------|----------------------|--------------------------|
| 1 | `SpannerDialect` | class | standalone; satisfies `BuildQueryConfig` | `drizzle-orm/sql` (`SQL`, `Query`, `QueryWithTypings`), `drizzle-orm/casing` (`CasingCache`), `drizzle-orm/relations` (RQB helpers) |
| 2 | `SpannerSession` | abstract class | standalone | `drizzle-orm/sql` (`Query`, `SQL`) |
| 3 | `SpannerPreparedQuery` | abstract class | implements `PreparedQuery` | `drizzle-orm/session` |
| 4 | `SpannerTransaction` | abstract class | extends `SpannerDatabase` | local |
| 5 | `SpannerDatabase` | class | standalone | `drizzle-orm/query-builders/query-builder` (`TypedQueryBuilder`), `drizzle-orm/selection-proxy` |
| 6 | `SpannerTable` + `spannerTable()` | class + factory | extends `Table` | `drizzle-orm/table` |
| 7 | `SpannerColumn` | abstract class | extends `Column` | `drizzle-orm/column` |
| 8 | `SpannerColumnBuilder` | abstract class | extends `ColumnBuilder` | `drizzle-orm/column-builder` |
| 9 | Column types: `int64`, `float64`, `float32`, `numeric`, `string`, `bytes`, `bool`, `date`, `timestamp`, `json`, `array` | builder pairs | extend items 7 and 8 | local |
| 10 | `SpannerSelectBuilder`, `SpannerSelect` | classes | extend `QueryPromise`; implement `RunnableQuery`, `SQLWrapper` | `drizzle-orm/query-promise`, `drizzle-orm/runnable-query`, `drizzle-orm/sql` |
| 11 | `SpannerInsert`, `SpannerUpdate`, `SpannerDelete`, `$count` | classes | same pattern as item 10 | same as item 10 |
| 12 | `BuildSpannerColumns`, `SpannerBuildColumn` type helpers | types | local replacement for closed `Dialect` union | replaces helpers in `drizzle-orm/column-builder` |
| 13 | Index / primary-key / foreign-key builders (incl. `INTERLEAVE IN PARENT`) | classes | standalone | local |
| 14 | `drizzle()` driver entry for `@google-cloud/spanner` | function | wires items 1, 2, 5 | `drizzle-orm/utils` (`DrizzleConfig`), `drizzle-orm/logger`, `drizzle-orm/cache/core` |
| 15 | `migrate()` | function | custom; kit has no spanner support | `drizzle-orm/migrator` (`readMigrationFiles`) |
| 16 | `entityKind` marker on every class | static field | required by `is()` dispatch | `drizzle-orm/entity` |

## Method notes

- Installed both beta packages into a scratch directory with npm.
- Read the `package.json` exports map of `drizzle-orm` (about 700 subpath entries).
- Read the `.d.ts` files of `gel-core`, `gel`, `column-builder`, `table`, `session`, `sql/sql`, `relations`, `entity`, `utils`, and `migrator`.
- Read the `drizzle-kit` `index.d.mts` dialect declaration and exports map.
