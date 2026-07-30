# 0001 — UPDATE/DELETE without `.where()` compile to `WHERE TRUE`

## Status

Accepted (2026-07-30).

## Context

Spanner GoogleSQL rejects `UPDATE` and `DELETE` statements that have no
`WHERE` clause. Drizzle's API convention, shared by every first-party
dialect, is that `db.update(t).set(...)` and `db.delete(t)` without
`.where()` affect **all rows**.

## Decision

`buildUpdateQuery` and `buildDeleteQuery` emit `where true` when no
`.where()` was given, preserving drizzle's all-rows semantics on Spanner.

## Consequences

- Behavior matches what drizzle users expect from other dialects.
- A forgotten `.where()` silently affects every row — the same footgun
  drizzle has everywhere; nothing Spanner-specific mitigates or worsens it.
- If a guarded mode is ever wanted, it belongs in user-side linting, not in
  the dialect.
