# Research: drizzle-kit extensibility for a third-party dialect

Resolves issue #6. Date: 2026-07-29.

## Summary

- drizzle-kit is open source. The source lives in the `drizzle-team/drizzle-orm` monorepo, in the `drizzle-kit/` directory.
- The dialect list is closed. It is a hardcoded readonly array. There is no plugin API.
- A programmatic API exists. It targets only the built-in dialects.
- Conclusion: we must build a separate `drizzle-spanner-kit` CLI. We can copy the drizzle-kit design. The license permits this.

## Versions and licensing

- `drizzle-orm@beta` is `1.0.0-beta.22`.
- The paired kit version is `drizzle-kit@1.0.0-beta.22` (dist-tag `beta`).
- The latest stable kit is `drizzle-kit@0.31.10`.
- The `drizzle-kit` package declares the MIT license in its `package.json`.
- The monorepo root license is Apache-2.0.
- Both licenses are permissive. We can reuse and adapt the source with attribution.
- The monorepo contains the full kit source: `drizzle-kit/src/`, tests, and build scripts. This is verified on the `beta` branch.

## The dialect list is closed

- The config types declare: `declare const dialects: readonly ["postgresql", "mysql", "sqlite", "turso", "singlestore", "gel", "mssql", "cockroach", "duckdb"]` (see `index.d.ts` line 8 in the beta package).
- The `Config` type is a discriminated union over this array. Each command validates `dialect` against it.
- The CLI rejects any other value. There is no registration hook.
- Each dialect is a directory under `drizzle-kit/src/dialects/`. Dialects are wired at build time, not at run time.
- `spanner` is not in the list. An external package cannot add it.

## Programmatic APIs

Two API surfaces exist in the beta package. Both are dialect-locked.

### Root SDK (`drizzle-kit`)

- Exports: `defineConfig`, `generate`, `push`, `check`, `pull`, `up`, `exportSql`.
- Each function takes a config with the closed `dialect` union.
- The functions return the same JSON envelope as `--output json`. The contract is in `drizzle-kit/JSON_CONTRACT.md` in the monorepo.

### Per-dialect API entry points

- Subpath exports: `drizzle-kit/api-postgres`, `drizzle-kit/api-mysql`, `drizzle-kit/api-sqlite`.
- Each exports: `generateDrizzleJson`, `generateMigration`, `pushSchema`, `startStudioServer`, `up`.
- Example signature: `generateMigration(prev: PostgresSnapshot, cur: PostgresSnapshot) => Promise<string[]>`.
- The snapshot types are dialect-specific. There is no generic dialect interface in the public API.

## Snapshot format (beta, version 8)

The beta rewrote the snapshot format. It is now a flat DDL entity list, not a nested object tree.

```jsonc
{
  "version": "8",
  "dialect": "postgres",        // fixed literal per dialect
  "id": "<uuid>",
  "prevIds": ["<uuid>"],         // chain to parent snapshots
  "ddl": [ /* entity objects */ ],
  "renames": []                  // recorded rename resolutions
}
```

- Each `ddl` entry is one entity object with an `entityType` discriminator.
- Postgres entity types: `schemas`, `tables`, `columns`, `indexes`, `pks`, `fks`, `uniques`, `checks`, `enums`, `sequences`, `views`, `policies`, `roles`, `privileges`.
- Each entity carries common keys: `schema`, `table`, `name` (nullable where not applicable).
- A small custom validator (`src/dialects/simpleValidator.ts` plus a per-dialect `snapshot.ts`) parses snapshots. Zod is not used in beta.
- Stable 0.31.x uses the older version 7 format. That format is a nested object with `tables`, `enums`, `_meta`, and a `meta/_journal.json` index. Do not target version 7 for new work.

## Migration folder layout (beta)

- One directory per migration: `<out>/<timestamp>_<name>/`.
- The timestamp is 14 digits: `YYYYMMDDHHMMSS`.
- Each directory contains `migration.sql` and `snapshot.json`.
- Statements in `migration.sql` are separated by the `--> statement-breakpoint` marker.
- The old `meta/_journal.json` layout is gone. `drizzle-orm`'s `readMigrationFiles` throws an error when it finds one and tells the user to run `drizzle-kit up`.

## Migration bookkeeping table (drizzle-orm migrator)

- Default table name: `__drizzle_migrations`.
- Postgres puts it in schema `drizzle` by default. Both names are configurable (`migrationsTable`, `migrationsSchema`).
- Columns (postgres): `id SERIAL PRIMARY KEY`, `hash text NOT NULL`, `created_at bigint`, `name text`, `applied_at timestamp with time zone DEFAULT now()`.
- `hash` is the SHA-256 hex digest of the full `migration.sql` file.
- `created_at` is the folder timestamp converted to epoch millis.
- The migrator compares local migrations to the table rows and applies the missing ones in one transaction.
- Spanner note: Spanner has no `SERIAL` and separates DDL from DML. `drizzle-spanner-kit` must keep the same column semantics but adapt the DDL, and must run schema changes through the Spanner DDL API, not inside a DML transaction.

## What drizzle-spanner-kit must build

The dialect list is closed, so we build our own CLI. Required parts:

1. **Schema serializer.** Load the user's Drizzle schema TS files (drizzle-kit uses `jiti`/`esbuild`). Walk the drizzle-orm table objects. Emit a version-8-style snapshot with Spanner entity types (tables, columns, pks, indexes, fks, interleave info, TTL policies).
2. **Snapshot differ.** Compare the previous snapshot to the current one. Detect create, drop, alter, and rename. Prompt the user to resolve ambiguous renames, as drizzle-kit does. Record resolutions in `renames`.
3. **DDL generator.** Convert the diff to GoogleSQL DDL statements. Respect Spanner limits: no column drop with an index on it, interleaved table ordering, `ALTER TABLE ... ALTER COLUMN` restrictions.
4. **generate command.** Write `<timestamp>_<name>/migration.sql` and `snapshot.json`. Keep the `--> statement-breakpoint` convention so tooling stays compatible.
5. **migrate command.** Create and use a `__drizzle_migrations`-compatible table in Spanner. Apply DDL via the `updateDatabaseDdl` admin API. Insert bookkeeping rows via DML. Match the drizzle-orm hash and timestamp semantics.
6. **push command (optional).** Diff the live database against the schema and apply directly, without migration files.
7. **Introspection (pull).** Query `INFORMATION_SCHEMA.TABLES`, `COLUMNS`, `INDEXES`, `INDEX_COLUMNS`, `TABLE_CONSTRAINTS`, `KEY_COLUMN_USAGE`, and `CHANGE_STREAMS`. Build a snapshot and emit schema TS code.
8. **CLI wiring.** drizzle-kit uses `@drizzle-team/brocli` for commands and reads `drizzle.config.ts`. Reuse both conventions so the UX matches.

## How much of the drizzle-kit design is reusable

- All of it, as reference. The source is public and permissively licensed.
- Directly copyable patterns: the DDL entity store (`src/dialects/dialect.ts` generic entity-schema builder), the snapshot validator pattern, the diff/rename-resolution flow, the migration folder writer, and the JSON output contract (`JSON_CONTRACT.md`, `SDK.md`).
- Not reusable as a dependency: the config parser and command dispatch, because the dialect enum is closed.
- Partially reusable at run time: drizzle-orm's `readMigrationFiles` is dialect-neutral and importable. Our migrator can consume it directly.
- Risk: the beta snapshot format is new and can still change before 1.0. Pin the reference version (`1.0.0-beta.22`) and re-check at 1.0.

## Sources

- npm: `drizzle-kit@1.0.0-beta.22`, `drizzle-orm@1.0.0-beta.22` (inspected dist and type declarations).
- GitHub: `drizzle-team/drizzle-orm` `beta` branch, `drizzle-kit/` directory (`SDK.md`, `JSON_CONTRACT.md`, `src/dialects/`).
