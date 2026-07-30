# drizzle-spanner-kit

Migration CLI for [drizzle-spanner](https://github.com/brandhaug/drizzle-spanner):
`generate`, `migrate`, `pull` and `push` against Google Cloud Spanner
(GoogleSQL). drizzle-kit's dialect list is closed, so Spanner migrations ship
as this standalone CLI, reusing drizzle-kit's design (snapshots, folder
format) as reference.

## Installation

```bash
npm install --save-dev drizzle-spanner-kit
```

`drizzle-spanner` and `drizzle-orm` are peer dependencies.
`@google-cloud/spanner` is an optional peer: `generate` runs without it;
`migrate`, `pull` and `push` need it to reach a database.

Node >= 22.18 (the config loader uses the runtime's native TypeScript
support) or Bun.

## Commands

```
drizzle-spanner-kit <command> [options]
```

| Command    | What it does                                                                     |
| ---------- | -------------------------------------------------------------------------------- |
| `generate` | Diff the schema against the latest snapshot and write a migration folder         |
| `migrate`  | Apply pending migrations as batched `updateSchema` DDL operations                 |
| `pull`     | Introspect `INFORMATION_SCHEMA` into schema files and a baseline snapshot        |
| `push`     | Diff the schema against the live database, print the full DDL plan, ask, apply   |

Options:

| Option                | Applies to        | Meaning                                                                 |
| --------------------- | ----------------- | ----------------------------------------------------------------------- |
| `--config <path>`     | all               | Config file, default `./drizzle-spanner.config.ts`                      |
| `--name <name>`       | `generate`        | Migration name, default `migration`                                     |
| `--schema-file <path>`| `pull`            | Output schema module, default `<out>/schema.ts`                         |
| `--no-interactive`    | `generate`, `push`| Never prompt; ambiguous renames refuse unless `--accept-drops`          |
| `--accept-drops`      | `generate`, `push`| With `--no-interactive`: treat ambiguous renames as drop + create       |
| `--yes`               | `push`            | Apply the printed plan without prompting                                |

`migrate` records applied migrations in a `drizzle_migrations` table (UUID
primary key, sha256 hash per migration), so re-running is a no-op.
Applications that migrate at startup can use the runtime migrator from
`drizzle-spanner/migrator` instead; it consumes the same migration folder.

## Config file

`drizzle-spanner.config.ts` default-exports a config object; `defineConfig`
is an identity helper for typing:

```ts
import { defineConfig } from 'drizzle-spanner-kit';

export default defineConfig({
  // Schema module path(s) exporting spannerTable / sequence values.
  schema: './src/schema.ts',
  // Migrations folder; defaults to './drizzle'.
  out: './drizzle',
  // Required by migrate, pull and push; generate runs without it.
  database: {
    project: 'my-project',
    instance: 'my-instance',
    database: 'my-database',
    // Optional: route the client at the emulator instead of live Spanner.
    emulatorHost: 'localhost:9010',
  },
});
```

| Key                     | Type                 | Required | Meaning                                                  |
| ----------------------- | -------------------- | -------- | -------------------------------------------------------- |
| `schema`                | `string \| string[]` | yes      | Schema module path(s); relative to the config file       |
| `out`                   | `string`             | no       | Migrations folder, default `./drizzle`                   |
| `database.project`      | `string`             | for db commands | GCP project id                                    |
| `database.instance`     | `string`             | for db commands | Spanner instance id                               |
| `database.database`     | `string`             | for db commands | Database id                                       |
| `database.emulatorHost` | `string`             | no       | `host:port` of a Spanner emulator                        |

`.js` and `.mjs` config files also load. Relative `schema` and `out` paths
resolve against the config file's directory.

## Refuse-and-explain diagnostics

Spanner cannot express some DDL changes. When a diff needs one of them,
`generate` refuses with a typed diagnostic (`DiffRefusedError`, carrying
every finding at once) instead of silently emitting `DROP` + `CREATE`.
`push` shares the differ and inherits every rule below.

The manual path for a table-level change is: create a new table, backfill,
swap reads/writes, drop the old table. For a column-level change: add a new
column, backfill, migrate readers, drop the old column.

| Diagnostic                | Why it refuses                                                                                       | Manual path |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| `primary-key-change`      | Spanner cannot alter a table's primary key after creation.                                            | New table, backfill, swap |
| `interleave-change`       | A table's interleaving (parent or `ON DELETE`) is fixed at creation.                                   | New table, backfill, swap |
| `column-type-change`      | Only `STRING`/`BYTES` length changes and `STRING`<->`BYTES` conversions are alterable; anything else is not. | New column, backfill, swap |
| `generated-column-change` | A generated / identity column definition cannot be altered.                                            | New column, backfill, swap |
| `column-rename`           | Spanner has no `RENAME COLUMN`, so a confirmed rename cannot be executed as one.                        | New column, backfill, swap |
| `ambiguous-rename`        | A dropped table/column has same-shaped created candidates; the differ will not guess which are renames. | Run interactively to resolve, or pass `--accept-drops` to treat them as drop + create |

Table renames are not refused: Spanner has `ALTER TABLE ... RENAME TO`, and
interactive runs offer rename resolution for dropped tables with candidates.

## License

MIT
