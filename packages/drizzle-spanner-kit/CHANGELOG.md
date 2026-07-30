# Changelog

All notable changes to `drizzle-spanner-kit` are recorded here. Both packages
in this repository version and release in lockstep from a single `v<version>`
tag; see [RELEASING.md](../../RELEASING.md).

## 0.1.0

Initial release.

- `generate`: snapshot-based diffing to GoogleSQL DDL migrations, with
  refuse-and-explain diagnostics for DDL Spanner cannot express.
- `migrate`: applies migrations as batched `updateSchema` operations and
  records them in the `drizzle_migrations` table.
- `pull`: introspects `INFORMATION_SCHEMA` into drizzle-spanner schema files.
- `push`: diffs the live database, prints the full DDL plan, and asks for
  confirmation before applying.
