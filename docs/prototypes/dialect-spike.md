# Prototype: dialect spike against the Spanner emulator

Spike for issue #12. The spike tests the dialect strategy from issue #8 and the
draft schema API from issue #9 end to end. The code is throwaway code. Do not
reuse it as production code. The code is on the branch `prototype/dialect-spike`
in the `spike/` directory.

## Verdict

The strategy operates end to end. The CRUD round-trip and the read-write
transaction ran green against the emulator. No assumption from #8 or #9 broke
at runtime.

## What the spike contains

- `spike/dialect.js` — `SpannerDialect`. Backtick identifiers. Named
  parameters in the form `@p0`. `buildSelectQuery`, `buildInsertQuery`,
  `buildUpdateQuery`, `buildDeleteQuery`. `THEN RETURN` instead of
  `RETURNING`. Trimmed from `gel-core/dialect.ts` as reference reading.
- `spike/session.js` — `SpannerSession` and `SpannerPreparedQuery` over
  `@google-cloud/spanner`. Reads run through `database.run()`. DML runs
  through `database.runTransactionAsync()`. The prepared query converts the
  positional parameter array to named parameters and emits Spanner parameter
  type hints.
- `spike/columns.js`, `spike/table.js` — `spannerTable()` factory plus
  `string`, `int64`, and `timestamp` builders on the exported
  `ColumnBuilder` and `Column` base classes.
- `spike/db.js` — `SpannerDatabase`, `SpannerTransaction`, and minimal
  select, insert, update, and delete builders on `QueryPromise`.
- `spike/driver.js` — the `drizzle(database, config)` entry point.
- `spike/run.js` — the end-to-end script.

## How to run the spike

1. Run `docker compose up -d`.
2. Run `npm install`.
3. Run `SPANNER_EMULATOR_HOST=localhost:9010 npm run emulator:bootstrap`.
4. Run `SPANNER_EMULATOR_HOST=localhost:9010 node spike/run.js`.

The script creates the table `singers` with `updateSchema` and hand-written
DDL. The primary key is a `STRING(36)` column with the default
`GENERATE_UUID()`. The script then runs insert with `.returning()`, select
with `where`, update, delete, one raw query, and one `db.transaction()`
read-write transaction. All statements use parameter binding. The script
prints `SPIKE PASSED` on success.

## Assumptions from #8 that held

- **The Gel pattern operates.** Own classes over exported base modules only.
  The runtime imports come only from permitted base subpaths: `entity`,
  `table`, `column`, `column-builder`, `sql`, `sql/expressions`,
  `query-promise`, `utils`, `casing`, `logger`. No import from another
  dialect's core.
- **The dialect satisfies the `BuildQueryConfig` contract.** `SQL.toQuery`
  rendered correct GoogleSQL with backtick identifiers and `@p0`-style named
  parameters. `escapeParam(num)` returns `@p{num}` and the parameter array
  index matches the placeholder number.
- **The shared SQL machinery is reusable.** `sql` template, `Param`,
  `fillPlaceholders`, `orderSelectedFields`, `mapResultRow`, `QueryPromise`,
  `CasingCache`, and the `eq` / `gt` expression helpers all operated with the
  Spanner classes without change.
- **The `entityKind` dispatch operates for external classes.** `is()` checks
  on base kinds passed for the Spanner subclasses.
- **Blocker 3 from the research doc (closed `QueryTypingsValue` union) is
  type-level only.** At runtime, `prepareTyping` can return the strings
  `int64`, `string`, and `timestamp`. `SQL.toQuery` collects them into
  `typings` without validation. The session forwards them as Spanner
  parameter type hints (`types: { p0: 'int64' }`). Verified output:
  `{"sql":"... where \`s\`.\`plays\` = @p0 ...","params":[5,"x"],"typings":["int64","string"]}`.
- **Blocker 1 (closed `Dialect` type union) does not block the runtime.** The
  spike is plain JavaScript, so the cost did not apply here. The production
  package must still write local type helpers.

## Assumptions from #9 that held

- The draft schema API is expressible on the base builders:
  `spannerTable('singers', { id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(), ... })`.
- `string` with `length` or `'max'`, `int64`, and `timestamp` map cleanly to
  `STRING(n)`, `STRING(MAX)`, `INT64`, and `TIMESTAMP`.
- A string UUID primary key with the DDL default `GENERATE_UUID()` operates.
  An insert that omits the key emits the `DEFAULT` keyword in the `VALUES`
  list. The emulator accepts it. `THEN RETURN` returns the generated UUID.
- `int64` in number mode maps to a JavaScript `number` (decision 2). The
  driver returns an `Int` wrapper object; see the workarounds below.

## Assumptions that broke

None broke at runtime. The spike did not test: interleaving, commit
timestamps, the relational query builder, migrations, or the type-level API.
Those stay open for later tickets.

## Errors and workarounds

The end-to-end run passed on the first attempt. These points needed adapter
code or attention:

1. **Spanner rejects UPDATE and DELETE without WHERE.** The dialect emits
   `where true` when the builder has no `where` clause. Gel and pg do not do
   this.
2. **DML with `THEN RETURN` must run inside a read-write transaction.**
   `database.run()` rejects DML. The session wraps each standalone DML
   statement in `database.runTransactionAsync()` with `txn.run()` plus
   `txn.commit()`. `txn.run()` (not `txn.runUpdate()`) is required to receive
   the `THEN RETURN` rows.
3. **Named parameters need conversion.** Drizzle produces a positional
   parameter array. The prepared query converts it to the object form
   `{ p0: value }` plus a `types` map before it calls the driver.
4. **`INT64` returns as an `Int` wrapper in array row mode.** The row cell is
   `{ value: '42' }`. `SpannerInt64.mapFromDriverValue` unwraps it and calls
   `Number()`. Values above 2^53−1 lose precision here; this confirms the
   need for the typed error and the `bigint` mode in decision 2 of #9.
5. **`TIMESTAMP` returns as `PreciseDate`.** `PreciseDate` extends `Date`, so
   the mapping is safe.
6. **Array row mode needs one unwrap step.** A Spanner row is an array of
   `{ name, value }` cells. The prepared query maps each row to a plain value
   array before it calls `mapResultRow`.
7. **The emulator allows one read-write transaction at a time.** The spike
   runs statements in sequence, so this limit did not trigger. Concurrent
   test suites must serialize writes against the emulator.
8. **`drizzle-orm` does not export `./package.json`.** A version probe must
   read the file directly. Cosmetic.

## Transaction result

`db.transaction()` maps to `database.runTransactionAsync()`. Inside the
callback, all reads and DML run on the one `Transaction` object. The
transaction read its own uncommitted insert (row count 2 inside, as
expected). The commit applied the insert and the update atomically.
