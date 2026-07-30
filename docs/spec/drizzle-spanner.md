# drizzle-spanner specification

`drizzle-spanner` is a standalone adapter package that connects
[Drizzle ORM v1 beta](https://orm.drizzle.team) to
[Google Cloud Spanner](https://cloud.google.com/spanner) using the GoogleSQL
dialect. This document is the build-ready specification produced by the
wayfinder effort tracked in
[issue #1](https://github.com/brandhaug/drizzle-spanner/issues/1). Every design
decision below links to the ticket that resolved it; the research documents on
the `research/*` branches hold the supporting evidence.

Feasibility is proven: an end-to-end spike
([#12](https://github.com/brandhaug/drizzle-spanner/issues/12), branch
`prototype/dialect-spike`) ran CRUD with `THEN RETURN`, typed parameters, and a
read-write transaction against the Spanner emulator on
`drizzle-orm@1.0.0-beta.22` exported base modules only.

## Package layout

The package follows the Gel-pattern decision
([#8](https://github.com/brandhaug/drizzle-spanner/issues/8)): drizzle-spanner
owns every dialect class and extends only exported drizzle-orm base modules.

- **Packages:** `drizzle-spanner` (ORM adapter) and `drizzle-spanner-kit`
  (migration CLI), in one repository.
- **Peer dependencies:** `"drizzle-orm": ">=1.0.0-beta.22 <1.0.0"`, and
  `@google-cloud/spanner` as an **optional** peer — the runtime takes the
  driver's `Database` structurally and never hard-imports the package, so
  `drizzle.mock()` and SQL-generation use need no driver install — with a
  documented list of tested beta versions and a CI matrix that runs against
  each new beta. A breaking beta must fail in CI, not in a user application.
- **Permitted imports:** only the base subpaths verified in
  `docs/research/drizzle-dialect-internals.md` (`entity`, `table`, `column`,
  `column-builder`, `sql`, `session`, `query-promise`, `runnable-query`,
  `query-builders/query-builder`, `selection-proxy`, `subquery`, `alias`,
  `relations`, `casing`, `utils`, `errors`, `logger`, `tracing`, `migrator`,
  `cache/core`). Other dialects' cores are reference reading only. An ESLint
  `no-restricted-imports` rule enforces this.
- **Deliverables:** the 16-item table in the dialect-internals research is the
  class inventory: `SpannerDialect`, `SpannerSession`, `SpannerPreparedQuery`,
  `SpannerTransaction`, `SpannerDatabase`, `SpannerTable` + `spannerTable()`,
  column builder pairs, query builders, local `BuildSpannerColumns` type
  helpers (the upstream `Dialect` type union is closed), a `drizzle()` driver
  entry point for `@google-cloud/spanner`, and a `migrate()` function.
- **Build and publish:** ESM-first with `exports` map subpaths mirroring
  drizzle-orm's layout (`drizzle-spanner`, `drizzle-spanner/migrator`, and a
  future `drizzle-spanner/effect`). Every class carries a
  `static [entityKind]` marker so drizzle's `is()` dispatch works.
- **Runtimes:** Node is first-class. Bun is supported and verified by the
  emulator smoke test (gRPC over `node:http2` passed on Bun 1.3.3, see
  [#7](https://github.com/brandhaug/drizzle-spanner/issues/7)). Edge runtimes
  are unsupported: `@google-cloud/spanner` requires gRPC.

## Schema definition API

Resolved in [#9](https://github.com/brandhaug/drizzle-spanner/issues/9). Column
builders use Spanner-native type names, so schema code mirrors DDL one to one.

- **Types:** `string`, `int64`, `float64`, `float32`, `numeric`, `bytes`,
  `bool`, `date`, `timestamp`, `json`, `array`, `tokenlist`. `string` and
  `bytes` require `{ length: n | 'max' }`. The full GoogleSQL mapping table is
  in `docs/research/spanner-googlesql-surface.md`.
- **INT64:** `int64('n')` maps to `number` and surfaces a typed error when the
  driver decodes a value past 2^53−1. `int64('n', { mode: 'bigint' })` maps to
  `bigint` for the full range.
- **Primary keys:** Spanner requires a primary key and has no auto-increment.
  The adapter exposes all three alternatives: `.defaultGenerateUuid()` on
  string columns, `.generatedAsIdentity()` on int64 columns (bit-reversed),
  and a `sequence()` helper. Documentation leads with UUID string keys.
- **Interleaving:** an extra-config entry,
  `interleaveInParent(parent, { onDelete: 'cascade' | 'noAction' })`, in the
  third argument of `spannerTable`. The types check at compile time that the
  child declares every parent primary-key column with a matching data type
  (for keys declared with `.primaryKey()` on the column builder — TypeScript
  cannot see key order or composite `primaryKey({ columns })` entries);
  `spannerTable` validates the full name-order prefix rule at definition
  time.
- **Commit timestamps:** `timestamp('col', { allowCommitTimestamp: true })`
  declares the DDL option; the exported `commitTimestamp()` sentinel is the
  write-site value in `values()` and `set()`. The value is unreadable until
  the transaction commits.
- **Indexes and the rest:** `index().on(...)` with Spanner extensions
  `.nullFiltered()` and `.storing(...)`; generated columns via
  `.generatedAlwaysAs(sql)`; defaults via `.default()`; foreign keys have no
  `ON UPDATE`.

```ts
const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true }),
});

const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 }),
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_title').on(t.title).nullFiltered(),
  ],
);
```

## Runtime API

Resolved in [#10](https://github.com/brandhaug/drizzle-spanner/issues/10). The
entry point follows the drizzle idiom: `drizzle(client)` takes a constructed
`@google-cloud/spanner` `Database`; session-pool configuration belongs to the
client; `DrizzleConfig` keys (`logger`, `casing`, `relations`, `cache`) pass
through.

- **Read-write transactions:** `db.transaction(async (tx) => { ... })` runs
  through `runTransactionAsync`. The callback re-executes automatically on
  `ABORTED`; documentation states loudly that the callback must be free of
  external side effects. Options: `{ maxRetries, timeout }`.
- **Reads and DML routing:** plain reads use `database.run`; all DML executes
  inside `runTransactionAsync` (the Node client's `run` is read-only). The
  adapter emits parameter type hints derived from the schema, because untyped
  null parameters and empty arrays fail with `INVALID_ARGUMENT`.
- **Read-only transactions and stale reads:**
  `db.transaction(cb, { readOnly: true, staleness: { exactStaleness: '15s' } })`
  gives multi-statement consistent snapshots;
  `db.select().from(t).withStaleness({ ... })` compiles to a single-use
  bounded read. Staleness bounds: `strong`, `exactStaleness`, `maxStaleness`
  (single-use only, per Spanner), `readTimestamp`, and `minReadTimestamp`.
  The types forbid `withStaleness` inside a read-write transaction.
- **Mutations:** `db.transaction(cb, { mode: 'bufferedMutations' })`. Inside
  this mode the insert, update, and delete builders compile to Spanner
  mutations buffered until commit; reads and `.returning()` throw typed
  errors. Model: `ruby-spanner-activerecord`'s `isolation:
  :buffered_mutations`. There is no `db.mutate` namespace in v1. The open
  item on `INSERT OR UPDATE` availability is resolved: it is available,
  including with `THEN RETURN` (see `docs/adr/0002-upsert-via-insert-or-update.md`);
  the upsert API ships after milestone 2.
- **Returning:** `.returning()` compiles to `THEN RETURN` (verified in the
  spike).
- **Standard drizzle idioms:** `db.$count(table, where?)` (a `COUNT(*)`
  convenience), `db.execute(sql)` (raw-SQL escape hatch), and
  `drizzle.mock()` (a client-less database for SQL generation and tests)
  ship with the runtime, matching first-party dialects.

```ts
const db = drizzle(spannerDatabase, { relations });

await db.transaction(async (tx) => {
  await tx.update(singers).set({ name: 'Ada L.' }).where(eq(singers.id, id));
}); // re-runs automatically on ABORTED

const rows = await db
  .select()
  .from(singers)
  .withStaleness({ exactStaleness: '15s' });

await db.transaction(
  async (tx) => {
    await tx.insert(events).values(batch); // buffered mutations
  },
  { mode: 'bufferedMutations' },
);
```

## Migrations and introspection

Resolved in [#11](https://github.com/brandhaug/drizzle-spanner/issues/11).
drizzle-kit's dialect list is closed with no plugin API
([#6](https://github.com/brandhaug/drizzle-spanner/issues/6)), so migrations
ship as a custom CLI, `drizzle-spanner-kit`, that reuses drizzle-kit's design
as reference.

- **Commands:** `generate`, `migrate`, `pull`, and `push` all ship in v1.
- **Snapshots:** drizzle-kit's v8 shape —
  `{ version, dialect: 'spanner', id, prevIds, ddl: Entity[], renames }` —
  with Spanner entities for interleaving, commit-timestamp flags, index
  options, and sequences.
- **Irreversible DDL:** when a diff requires an impossible change (primary-key
  change, interleave change), `generate` refuses with a typed diagnostic that
  explains the manual path (new table, backfill, swap). The tool never emits a
  silent `DROP` + `CREATE`. `push` shares the differ and inherits this rule,
  and always prints the full DDL plan and asks for confirmation first.
- **Applying:** `migrate` applies each migration through `updateSchema` as one
  batched long-running DDL operation and records completion in a
  `__drizzle_migrations` table with a `STRING(36)` UUID primary key and a
  sha256 hash column — never an auto-increment pattern.
- **Introspection:** `pull` reads `INFORMATION_SCHEMA` (tables, columns,
  interleaving via `PARENT_TABLE_NAME`, indexes, sequences, foreign keys,
  check constraints) and emits schema files in the schema API above.

## Relational queries

Resolved in [#14](https://github.com/brandhaug/drizzle-spanner/issues/14).

- **Declaration:** relations stay fully explicit through `defineRelations`.
  The adapter derives nothing from `interleaveInParent`; interleaving is
  physical layout, relations are query semantics. Documentation shows the
  canonical pairing on one parent-child example.
- **SQL strategy:** `buildRelationalQuery` compiles nested collections to
  correlated `ARRAY(SELECT AS STRUCT ... ORDER BY ... LIMIT n)` subqueries —
  one round trip, full type fidelity through STRUCT decoding, and Spanner's
  most efficient read path for interleaved children. JSON aggregation is not
  used.
- **Feature scope:** v1 supports nested `with` at arbitrary depth, `where` on
  relations, `orderBy` and `limit` on nested collections, and `extras`.
  `extras` rides on the STRUCT decode path and is the first candidate to
  defer to milestone 2 if it proves costly.

## Error handling

Sharpened from the map's fog during assembly. The adapter wraps Spanner and
gRPC errors in a typed `SpannerError` discriminated union so failures are
matchable by kind and later usable as an Effect failure channel:

- `SpannerAbortedError` — surfaced only when retries are exhausted.
- `SpannerConstraintError` — unique index, foreign key, and check violations.
- `SpannerInvalidArgumentError` — includes the untyped-parameter case with a
  hint naming the column.
- `SpannerPrecisionError` — INT64 decode past 2^53−1 in `number` mode.
- `SpannerDdlError` — failed or partially applied `updateSchema` operations.
- `SpannerUnavailableError` — transport and deadline failures.

Each variant carries the gRPC status code, the raw error, and — when a
statement produced the failure — the SQL (with parameter names, never
values). Transaction-level failures (begin, commit, retry exhaustion) have no
single statement, so they carry the code and the raw error only.

## Test strategy

- **Unit tests** cover SQL generation (dialect output) without a database.
- **Integration tests** run against the Spanner emulator via testcontainers:
  one container per test worker, because emulator state is in-memory (free
  isolation) and the emulator serializes read-write transactions. The
  docker-compose setup from
  [#7](https://github.com/brandhaug/drizzle-spanner/issues/7) (branch
  `task/spanner-emulator`) remains the interactive dev loop.
- **Runtime matrix:** Node (LTS) and Bun run the integration suite.
- **Beta matrix:** CI runs the suite against each supported drizzle-orm beta;
  the tested-versions list in the README is generated from this matrix.
- **Emulator limits** (from `docs/emulator.md` and the research): no IAM, no
  persistence, serialized read-write transactions; anything the emulator
  cannot execute gets a nightly job against a real Spanner instance.

## Post-v1

These items are consciously out of v1 and recorded here so they are not
re-litigated:

- **Effect entrypoint** (`drizzle-spanner/effect`): a session variant that
  returns Effect values instead of Promises, mirroring
  `drizzle-orm/effect-postgres`. The session layer separation above is the
  enabling constraint. A true `@effect/sql-spanner` client is a separate
  future effort.
- **Batch DML, request priorities, and request tags.**
- **`db.mutate` namespace** (standalone mutations outside a transaction).
- **Drizzle Studio support** — blocked upstream on drizzle-kit's closed
  dialect list.
- **PostgreSQL-dialect Spanner** — out of scope for this package entirely.

## Implementation milestones

1. **Core query layer:** dialect, session, table, column builders, query
   builders, `drizzle()` entry point, error taxonomy, unit tests, emulator
   integration tests. Exit: the spike's scenarios pass as real tests, plus
   composite keys, interleaved tables, and all column types.
2. **Runtime completeness:** transactions with retry options, read-only and
   stale reads, buffered-mutations mode, commit-timestamp sentinel, RQB via
   `ARRAY(SELECT AS STRUCT)` (with `extras` last).
3. **drizzle-spanner-kit:** snapshot serializer, differ with refuse-and-explain
   diagnostics, `generate`/`migrate`, then `pull`, then `push`. The runtime
   `migrate()` function and the `drizzle-spanner/migrator` subpath ship here
   too: they consume the migration-folder format the kit's `generate` defines.
4. **Hardening and release:** beta CI matrix, Bun matrix, README, examples,
   npm publish.

## References

- Research: `docs/research/*` on branches `research/drizzle-dialect-internals`,
  `research/spanner-googlesql-surface`, `research/spanner-node-client`,
  `research/spanner-orm-prior-art`, `research/drizzle-kit-extensibility`.
- Spike: branch `prototype/dialect-spike`, notes in
  `docs/prototypes/dialect-spike.md`.
- Emulator environment: branch `task/spanner-emulator`, docs in
  `docs/emulator.md`.
- Decision tickets: [#8](https://github.com/brandhaug/drizzle-spanner/issues/8),
  [#9](https://github.com/brandhaug/drizzle-spanner/issues/9),
  [#10](https://github.com/brandhaug/drizzle-spanner/issues/10),
  [#11](https://github.com/brandhaug/drizzle-spanner/issues/11),
  [#14](https://github.com/brandhaug/drizzle-spanner/issues/14).
