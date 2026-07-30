# 0002 — Upsert story: `INSERT OR UPDATE` DML is available

## Status

Accepted (2026-07-30). Resolves the spec's open item "evaluate
`INSERT OR UPDATE` DML availability for an upsert story".

## Context

Spanner has no `ON CONFLICT` clause. GoogleSQL DML instead offers
`INSERT OR UPDATE INTO ...` (upsert: replaces the conflicting row) and
`INSERT OR IGNORE INTO ...` (keeps the existing row). Whether the
emulator supports them — and whether `THEN RETURN` composes with them —
decides if drizzle-spanner can offer an upsert API that the test suite
can exercise.

## Evaluation

Probed against the Spanner emulator (`gcr.io/cloud-spanner-emulator/
emulator:latest`, 2026-07-30), each statement in its own read-write
transaction:

- `INSERT OR UPDATE INTO singers (id, name) VALUES (...)` — accepted;
  updates the row when the key exists, inserts when it does not.
- `INSERT OR IGNORE INTO singers (...)` — accepted; leaves an existing
  row unchanged.
- `INSERT OR UPDATE ... THEN RETURN id, name` — accepted; returns the
  written row.

## Decision

An upsert story is feasible on plain DML. The planned API is
`db.insert(t).values(...).orUpdate()` and `.orIgnore()`, compiling to
`INSERT OR UPDATE INTO` / `INSERT OR IGNORE INTO`; `.returning()`
composes unchanged. Implementation is scheduled with milestone 3+ work,
not milestone 2.

## Consequences

- No `ON CONFLICT`-style partial column updates: `INSERT OR UPDATE`
  replaces the full column list given in the statement. The API docs
  must state this difference from other dialects' `onConflictDoUpdate`.
- `INSERT OR UPDATE` has no DML form inside the buffered-mutations
  transaction; there `.orUpdate()` compiles to Spanner's `insertOrUpdate`
  mutation instead (implemented with the upsert API). `.orIgnore()` has no
  mutation equivalent and throws a typed error in that mode.
