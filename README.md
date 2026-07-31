# drizzle-spanner

`drizzle-spanner` connects [Drizzle ORM v1 beta](https://orm.drizzle.team) to
[Google Cloud Spanner](https://cloud.google.com/spanner) using the GoogleSQL
dialect. It ships as two packages: `drizzle-spanner` (the ORM adapter) and
`drizzle-spanner-kit` (the migration CLI). The full design is in
[docs/spec/drizzle-spanner.md](docs/spec/drizzle-spanner.md).

<!-- prettier-ignore -->
> [!NOTE]
> This adapter targets Drizzle ORM v1 beta and is itself pre-release.

## Installation

Install the adapter next to `drizzle-orm` and the Spanner driver:

```bash
npm install drizzle-spanner drizzle-orm@1.0.0-beta.22 @google-cloud/spanner
```

`@google-cloud/spanner` is an optional peer dependency: the adapter takes the
driver's `Database` structurally and never imports the package itself, so
`drizzle.mock()` and pure SQL generation work without a driver install.

### Tested versions

CI runs the integration suite against each entry in this matrix; a breaking
`drizzle-orm` beta fails here, not in your application.

<!-- tested-versions:start -->

| drizzle-orm     | Runtimes              |
| --------------- | --------------------- |
| `1.0.0-beta.22` | Node 22, Node 24, Bun |

<!-- tested-versions:end -->

This table is generated from
[`.github/tested-versions.json`](.github/tested-versions.json) by
`node scripts/sync-tested-versions.ts`; CI fails when they drift.

### Runtime support

| Runtime       | Status                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------- |
| Node          | First-class. `engines` requires >= 20; CI tests the current LTS set.                        |
| Bun           | Supported; the integration suite runs under Bun in CI (gRPC over `node:http2`).             |
| Edge runtimes | **Unsupported.** `@google-cloud/spanner` requires gRPC, which edge runtimes do not provide. |

`drizzle-spanner-kit` needs Node >= 22.18 (it loads TypeScript config files
through the runtime's native TS support) or Bun.

## Quickstart

Define a schema, hand `drizzle()` the driver's `Database`, and query. Spanner
requires a primary key on every table and has no auto-increment; the
recommended default is a `STRING(36)` UUID key:

```ts
import { Spanner } from '@google-cloud/spanner'
import { drizzle, spannerTable, string, timestamp } from 'drizzle-spanner'

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true })
})

const spanner = new Spanner({ projectId: 'my-project' })
const database = spanner.instance('my-instance').database('my-database')
const db = drizzle(database)

const rows = await db.select().from(singers)
```

### Primary keys

Spanner has no auto-increment, and monotonically increasing keys hotspot its
range-sharded storage. The adapter exposes three alternatives, in order of
preference:

1. **UUID string keys** — `string('id', { length: 36 }).primaryKey().defaultGenerateUuid()`.
   The default choice.
2. **Bit-reversed identity** — `int64('id').primaryKey().generatedAsIdentity()`.
3. **Sequences** — the `sequence()` helper, for keys shared across tables.

## Interleaving and relational queries

Interleaving is physical layout; relations are query semantics. The adapter
derives nothing from one to the other, so the canonical parent-child setup
declares both — `interleaveInParent` in the table's extra config and the
relation through `defineRelations`:

Spanner matches the interleave prefix by column **name**: the child's
primary key must start with the parent's key columns under the same names,
so the parent key here is `singer_id`, not `id`. The types reject a child
that omits a parent key column, declares it with a different type, or puts
it in the wrong key position; `spannerTable` enforces the full rule at
definition time, including the key orders the types cannot read.

```ts
import { defineRelations } from 'drizzle-orm/relations'
import {
  index,
  interleaveInParent,
  primaryKey,
  spannerTable,
  string
} from 'drizzle-spanner'

const singers = spannerTable('singers', {
  singerId: string('singer_id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull()
})

const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 })
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_title').on(t.title).nullFiltered()
  ]
)

const relations = defineRelations({ singers, albums }, (r) => ({
  singers: {
    albums: r.many.albums()
  },
  albums: {
    singer: r.one.singers({
      from: r.albums.singerId,
      to: r.singers.singerId
    })
  }
}))

const db = drizzle(database, { relations })
const withAlbums = await db.query.singers.findMany({
  with: { albums: true }
})
```

Nested collections compile to correlated `ARRAY(SELECT AS STRUCT ...)`
subqueries — one round trip, and Spanner's most efficient read path for
interleaved children.

## Transactions

`db.transaction` runs a read-write transaction through the driver's retry
loop:

```ts
await db.transaction(
  async (tx) => {
    const [singer] = await tx.select().from(singers).limit(1)
    await tx.update(singers).set({ name: 'Ada' })
  },
  { maxRetries: 3, timeout: 60_000 }
)
```

<!-- prettier-ignore -->
> [!WARNING]
> The transaction callback must be free of external side effects. Spanner
> aborts read-write transactions under contention and the driver re-executes
> the whole callback, possibly several times. Anything that isn't a query —
> sending an email, writing a file, incrementing an in-memory counter — runs
> once per attempt, not once per transaction.

### Read-only transactions and stale reads

Read-only transactions run on a snapshot and accept a staleness bound
(`strong`, `exactStaleness`, or `readTimestamp`):

```ts
await db.transaction(
  async (tx) => {
    return tx.select().from(singers)
  },
  { readOnly: true, staleness: { exactStaleness: '15s' } }
)
```

Single-use bounded reads support two additional bounds, `maxStaleness` and
`minReadTimestamp`, which Spanner accepts on single-use reads only:

```ts
const rows = await db.select().from(singers).withStaleness({ maxStaleness: '10s' })
```

### Buffered mutations

`{ mode: 'bufferedMutations' }` compiles inserts, updates, and deletes to
Spanner mutations buffered until commit — the cheapest write path for bulk
writes that don't read. Reads and `.returning()` throw typed errors in this
mode.

```ts
await db.transaction(
  async (tx) => {
    await tx.insert(events).values(batch)
  },
  { mode: 'bufferedMutations' }
)
```

### Counting, raw SQL, and a client-less database

The standard drizzle idioms ship with the runtime: `db.$count` is a
`COUNT(*)` convenience, `db.execute(sql)` is the raw-SQL escape hatch, and
`drizzle.mock()` builds a database with no driver at all — SQL generation
and tests need no `@google-cloud/spanner` install:

```ts
const total = await db.$count(singers, eq(singers.name, 'Ada'))
const rows = await db.execute(sql`SELECT 1 AS one`)

const mockDb = drizzle.mock()
const { sql: text, params } = mockDb.select().from(singers).toSQL()
```

## Upsert

Spanner has no `ON CONFLICT`. `.orUpdate()` and `.orIgnore()` compile to
GoogleSQL's `INSERT OR UPDATE` / `INSERT OR IGNORE`, and `.returning()`
composes with both:

```ts
await db.insert(singers).values({ id, name: 'Ada' }).orUpdate().returning()
```

<!-- prettier-ignore -->
> [!IMPORTANT]
> On conflict, `INSERT OR UPDATE` replaces every column listed in the
> statement with the inserted value. There is no `onConflictDoUpdate`-style
> clause: you cannot update a different column set than you insert, and you
> cannot compute the update from the existing row (`SET x = x + 1`). See
> [ADR 0002](docs/adr/0002-upsert-via-insert-or-update.md).

## Migrations

`drizzle-spanner-kit` provides `generate`, `migrate`, `pull`, and `push`.
Configure it with a `drizzle-spanner.config.ts`:

```ts
import { defineConfig } from 'drizzle-spanner-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  database: {
    project: 'my-project',
    instance: 'my-instance',
    database: 'my-database'
  }
})
```

Generate a migration from your schema changes, then apply it:

```bash
npx drizzle-spanner-kit generate
npx drizzle-spanner-kit migrate
```

Applications that migrate at startup use the runtime migrator instead of the
CLI:

```ts
import { migrate } from 'drizzle-spanner/migrator'

await migrate(db, { migrationsFolder: './drizzle' })
```

Applied migrations are recorded in a `drizzle_migrations` bookkeeping table
(UUID primary key and a sha256 hash per migration), so re-running is a no-op.

Two more commands round out the workflow: `pull` introspects an existing
database (`INFORMATION_SCHEMA` — tables, columns, interleaving, indexes,
sequences, foreign keys, check constraints) into schema files and a baseline
snapshot, and `push` diffs the schema against the live database directly —
useful against the emulator during development:

```bash
npx drizzle-spanner-kit pull
npx drizzle-spanner-kit push
```

When a schema diff requires DDL Spanner cannot express (a primary-key or
interleave change), `generate` refuses with a diagnostic that explains the
manual path — it never emits a silent `DROP` + `CREATE`. `push` shares the
differ, prints the full DDL plan, and asks for confirmation before applying.
The full diagnostics catalogue is in the
[kit README](packages/drizzle-spanner-kit/README.md).

## Local development

The Spanner emulator covers the integration test suite and the dev loop:

```bash
npm run emulator:up
npm run test:integration
```

See [docs/emulator.md](docs/emulator.md) for the emulator's limits.

## Examples

Two runnable examples live in [examples/](examples/), verified against the
emulator in CI: [basic-crud](examples/basic-crud/) (schema, `migrate`, CRUD,
a read-write transaction) and [interleaved-rqb](examples/interleaved-rqb/)
(interleaved singers/albums, relational queries, buffered mutations, a stale
read, schema applied via `push`).

## References

- [Specification](docs/spec/drizzle-spanner.md)
- [ADR 0001 — UPDATE/DELETE without WHERE](docs/adr/0001-update-delete-without-where.md)
- [ADR 0002 — Upsert via INSERT OR UPDATE](docs/adr/0002-upsert-via-insert-or-update.md)
- [Drizzle discussion #2439 — Spanner support](https://github.com/drizzle-team/drizzle-orm/discussions/2439)
