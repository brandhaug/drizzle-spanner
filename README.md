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

| drizzle-orm      | Runtimes                |
| ---------------- | ----------------------- |
| `1.0.0-beta.22`  | Node 20+ (LTS), Bun     |

## Quickstart

Define a schema, hand `drizzle()` the driver's `Database`, and query. Spanner
requires a primary key on every table and has no auto-increment; the
recommended default is a `STRING(36)` UUID key:

```ts
import { Spanner } from '@google-cloud/spanner';
import { drizzle, spannerTable, string, timestamp } from 'drizzle-spanner';

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true }),
});

const spanner = new Spanner({ projectId: 'my-project' });
const database = spanner.instance('my-instance').database('my-database');
const db = drizzle(database);

const rows = await db.select().from(singers);
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

```ts
import { defineRelations } from 'drizzle-orm/relations';
import {
  index,
  interleaveInParent,
  primaryKey,
  spannerTable,
  string,
} from 'drizzle-spanner';

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

const relations = defineRelations({ singers, albums }, (r) => ({
  singers: {
    albums: r.many.albums(),
  },
  albums: {
    singer: r.one.singers({
      from: r.albums.singerId,
      to: r.singers.id,
    }),
  },
}));

const db = drizzle(database, { relations });
const withAlbums = await db.query.singers.findMany({
  with: { albums: true },
});
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
    const [singer] = await tx.select().from(singers).limit(1);
    await tx.update(singers).set({ name: 'Ada' });
  },
  { maxRetries: 3, timeout: 60_000 },
);
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
    return tx.select().from(singers);
  },
  { readOnly: true, staleness: { exactStaleness: '15s' } },
);
```

Single-use bounded reads support two additional bounds, `maxStaleness` and
`minReadTimestamp`, which Spanner accepts on single-use reads only:

```ts
const rows = await db
  .select()
  .from(singers)
  .withStaleness({ maxStaleness: '10s' });
```

### Buffered mutations

`{ mode: 'bufferedMutations' }` compiles inserts, updates, and deletes to
Spanner mutations buffered until commit — the cheapest write path for bulk
writes that don't read. Reads and `.returning()` throw typed errors in this
mode.

```ts
await db.transaction(
  async (tx) => {
    await tx.insert(events).values(batch);
  },
  { mode: 'bufferedMutations' },
);
```

## Upsert

Spanner has no `ON CONFLICT`. `.orUpdate()` and `.orIgnore()` compile to
GoogleSQL's `INSERT OR UPDATE` / `INSERT OR IGNORE`, and `.returning()`
composes with both:

```ts
await db
  .insert(singers)
  .values({ id, name: 'Ada' })
  .orUpdate()
  .returning();
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
import { defineConfig } from 'drizzle-spanner-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  database: {
    project: 'my-project',
    instance: 'my-instance',
    database: 'my-database',
  },
});
```

Generate a migration from your schema changes, then apply it:

```bash
npx drizzle-spanner-kit generate
npx drizzle-spanner-kit migrate
```

Applications that migrate at startup use the runtime migrator instead of the
CLI:

```ts
import { migrate } from 'drizzle-spanner/migrator';

await migrate(db, { migrationsFolder: './drizzle' });
```

Applied migrations are recorded in a `drizzle_migrations` bookkeeping table
(UUID primary key and a sha256 hash per migration), so re-running is a no-op.

When a schema diff requires DDL Spanner cannot express (a primary-key or
interleave change), `generate` refuses with a diagnostic that explains the
manual path — it never emits a silent `DROP` + `CREATE`. `push` shares the
differ, prints the full DDL plan, and asks for confirmation before applying.

## Local development

The Spanner emulator covers the integration test suite and the dev loop:

```bash
npm run emulator:up
npm run test:integration
```

See [docs/emulator.md](docs/emulator.md) for the emulator's limits.

## References

- [Specification](docs/spec/drizzle-spanner.md)
- [ADR 0001 — UPDATE/DELETE without WHERE](docs/adr/0001-update-delete-without-where.md)
- [ADR 0002 — Upsert via INSERT OR UPDATE](docs/adr/0002-upsert-via-insert-or-update.md)
- [Drizzle discussion #2439 — Spanner support](https://github.com/drizzle-team/drizzle-orm/discussions/2439)
