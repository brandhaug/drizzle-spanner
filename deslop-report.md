# Deslop report — 2026-07-30

Scope: entire codebase (388 tracked files, excludes: gitignored, dist, lockfiles, generated).
Seven parallel analysis agents: dedup, type consolidation, unused code, weak types, defensive programming, legacy code, AI slop.

**Verdict: unusually clean codebase.** Zero legacy/deprecated code, zero actionable AI slop, zero real defensive-programming issues. The actionable findings concentrate in three areas: unnecessary type casts (verified removable with `tsc`), dead exports in the kit package, and a diverged copy of the DDL-apply logic between the runtime and the kit.

Status legend: `pending` — awaiting decision. Findings below 0.7 confidence are quarantined in the "Needs review" section and are never auto-applied.

---

## High-confidence findings (≥ 0.7)

### unused — dead code in the kit (agent 3)

All verified by grep across src/, packages/, tests/, scripts/, examples/, docs/ and by export-map reachability (kit publishes only `index.ts` + `cli.js`; root publishes `.`, `./migrator`, `./internal`).

| # | File | Lines | Sev | Conf | Issue | Fix |
|---|------|-------|-----|------|-------|-----|
| U1 | packages/drizzle-spanner-kit/src/migrations.ts | 39–41 | high | 0.90 | `readMigrationSql` has zero call sites; unreachable from published entry points | Delete |
| U2 | packages/drizzle-spanner-kit/src/migrations.ts | 43–49 | high | 0.90 | `splitSqlStatements` has zero call sites; runtime migrator splits via drizzle-orm instead | Delete |
| U3 | packages/drizzle-spanner-kit/src/migrations.ts | 16 | low | 0.85 | `STATEMENT_BREAKPOINT` exported but only used in-file | Drop `export` |
| U4 | packages/drizzle-spanner-kit/src/migrations.ts | 19–37 | low | 0.85 | `listMigrationFolders` exported but only used in-file | Drop `export` |
| U5 | packages/drizzle-spanner-kit/src/migrations.ts | 51–54 | low | 0.85 | `readSnapshot` exported but only used in-file | Drop `export` |
| U6 | packages/drizzle-spanner-kit/src/migrations.ts | 71–73 | low | 0.85 | `renderMigrationSql` exported but only used in-file | Drop `export` |
| U7 | packages/drizzle-spanner-kit/src/migrations.ts | 7–13 | low | 0.80 | `MigrationFolder` interface exported but only used in-file | Drop `export` |
| U8 | packages/drizzle-spanner-kit/src/ddl.ts | 12 | low | 0.85 | `escapeIdentifier` exported but only used in-file | Drop `export` |
| U9 | packages/drizzle-spanner-kit/src/ddl.ts | 27 | low | 0.85 | `columnDefinitionSql` exported but only used in-file | Drop `export` |
| U10 | packages/drizzle-spanner-kit/src/commands/push.ts | 27 | low | 0.80 | `applyDdl` exported but only called in-file; not re-exported by index.ts | Drop `export` (superseded if D1 consolidation is applied) |
| U11 | src/orm-internal.ts | 11–14 | low | 0.75 | `SelectedFieldsOrderedItem` exported but only used in-file; not public surface | Drop `export` |
| U12 | src/orm-internal.ts | 18 | low | 0.75 | `SelectedFields` exported but only referenced in-file | Drop `export` |

### weak-types — unnecessary casts (agent 4)

Each "verified removable" claim was confirmed by applying the change and running `npx tsc --noEmit` (covers src, tests, scripts, kit).

| # | File | Lines | Sev | Conf | Issue | Fix |
|---|------|-------|-----|------|-------|-----|
| W1 | src/columns/common.ts | 107, 140 | med | 0.95 | `super(table as unknown as Table, config)` — double cast unnecessary | `super(table, config)` |
| W2 | src/columns/common.ts | 197 | med | 0.95 | `super(table, config as any)` in SpannerArray — unnecessary | `super(table, config)` |
| W3 | src/columns/common.ts | 82 | med | 0.95 | Trailing `as any` on `array()` return unnecessary (inner polymorphic-this cast must stay) | Drop only trailing `as any` |
| W4 | src/table.ts | 162 | low | 0.90 | `extraConfig as unknown as (...)` — single-step `as` compiles | Drop `unknown` step |
| W5 | src/dialect.ts | 284–286 | med | 0.95 | Redundant triple cast around `aliasedTable(config.table, ...)` | `const table = currentDepth ? config.table : aliasedTable(config.table, \`d${currentDepth}\`)` |
| W6 | src/dialect.ts | 251, 292–293, 301, 318, 327–329, 332, 346, 368 | med | 0.90 | 13 of 14 `as never` casts in RQB builder unnecessary; only `params.extras as never` (line 306) is load-bearing | Remove all except `params.extras` (add comment on the keeper) |
| W7 | src/dialect.ts | 317–322 | med | 0.95 | `aliasedTable(x as never, ...) as unknown as SpannerTable` — input cast unneeded, output can be single downcast | `aliasedTable(relation.targetTable, ...) as SpannerTable` |
| W8 | src/db.ts | 310 | low | 0.95 | `buildCountQuery(table as never, where)` — directly assignable | Drop cast |
| W9 | src/query-builders/query.ts | 128, 134, 155 | med | 0.80 | Constructor stores `config: unknown` then asserts away with `as never` | Export `SpannerRelationalQueryConfigEntry` from dialect.ts, type the param, one single-step cast at each of two callsites |
| W10 | src/migrator.ts | 99 | med | 0.85 | `migrate(db: SpannerDatabase<any>)` — `AnyRelations` is the correct bound | `SpannerDatabase<AnyRelations>` |
| W11 | packages/drizzle-spanner-kit/src/introspect.ts | 15 | med | 0.90 | `{ sql, json: true } as never` — cast exists only because KitDriverDatabase.run lacks `json` | Add `json?: boolean` to KitDriverDatabase run request; delete cast |
| W12 | packages/drizzle-spanner-kit/src/connect.ts | 39 | low | 0.95 | `as unknown as KitDriverDatabase` — single-step compiles | Drop `unknown` step |
| W13 | packages/drizzle-spanner-kit/src/commands/migrate.ts | 20 | med | 0.70 | `connection.database as unknown as SpannerDriverDatabase` — required today only because KitDriverDatabase lacks members | Make KitDriverDatabase extend SpannerDriverDatabase (design change to kit interface — borderline, see T3) |
| W14 | packages/drizzle-spanner-kit/src/serializer.ts | 97, 173 | low | 0.95 | `getTableColumns(table) as Record<string, SpannerColumn<any>>` — redundant at both sites | Drop cast |
| W15 | tests/unit/schema.test.ts | 217 | med | 0.95 | `interleaveInParent(singers) as any` — dead cast (expression type-checks without it) | Delete `as any` |
| W16 | tests/unit/schema.test.ts | 167 | low | 0.75 | `const builders: any[]` — values are IndexBuilder instances | Type as `IndexBuilder[]` + two assertion adjustments |
| W17 | tests/unit/rqb.test.ts | 165–187 | low | 0.90 | Mock cast via `as unknown as SpannerDriverDatabase`; direct annotation compiles and catches drift | Annotate mock directly |
| W18 | tests/unit/runtime.test.ts | 128, 322, 471 | low | 0.90 | `as unknown as SpannerDriverDatabase` — single-step compiles at all 3 sites | Drop `unknown` step |
| W19 | tests/integration/harness.ts | 31 | low | 0.90 | Same double-cast pattern | `database as SpannerDriverDatabase` |

Agent 4 side note (not a finding): tests/unit/schema.test.ts:217 asserts a runtime throw for a PK-prefix violation that the type layer does not catch, unlike the `@ts-expect-error` case at line 271 — possible gap in the InterleaveBuilder type check worth a separate look.

### dedup + types — the DDL-apply fork and friends (agents 1 & 2, merged)

| # | File | Lines | Sev | Conf | Issue | Fix |
|---|------|-------|-----|------|-------|-----|
| D1 | packages/drizzle-spanner-kit/src/commands/push.ts | 26–48 | high | 0.80 | `applyDdl()` is a diverged copy of `runDdl()` + `failedStatementIndex()` in src/migrator.ts:45–72 — same updateSchema call, operation.promise(), commitTimestamps-metadata parsing, and SpannerDdlError construction; message wording already drifted. Flagged independently by both agents 1 and 2. | Export a shared helper (e.g. `applyDdlStatements(client, statements, messageContext)` or at minimum `failedStatementIndex`) from drizzle-spanner via the existing `drizzle-spanner/migrator` entry; delegate from both sites |
| D2 | packages/drizzle-spanner-kit/src/codegen.ts | 159–172 | med | 0.80 | Inline parents-first topological ordering re-implements `orderTablesParentsFirst()` in differ.ts:209–235; copies already diverged — differ has a `visiting` cycle guard, codegen does not | Move `orderTablesParentsFirst` into entities.ts; use from both |
| D3 | packages/drizzle-spanner-kit/src/differ.ts | 365–383 | low | 0.85 | Two hand-rolled per-table FK groupings inline what `groupByTable()` in entities.ts already does | Replace both loops with `groupByTable(...)` |

### types — consolidation (agent 2)

| # | File | Lines | Sev | Conf | Issue | Fix |
|---|------|-------|-----|------|-------|-----|
| T1 | packages/drizzle-spanner-kit/src/snapshot.ts (+6 sites) | 13, 56; interleave.ts:5,48; serializer.ts:147; introspect.ts:33; ddl.ts:22 | med | 0.80 | `'cascade' \| 'noAction'` re-spelled inline in 7 places; `ForeignKeyAction` already exported from src/foreign-keys.ts | Use `ForeignKeyAction` in src/interleave.ts; in the kit either import it from drizzle-spanner or define one `OnDeleteAction` in snapshot.ts and reuse |
| T2 | packages/drizzle-spanner-kit/src/codegen.ts | 81 | low | 0.95 | `keyPartRef` takes inline `{ name: string; order: 'asc' \| 'desc' }` — exactly `KeyPart` from ./snapshot.js | Import and use `KeyPart` |
| T3 | packages/drizzle-spanner-kit/src/connect.ts | 4–12 | med | 0.70 | `KitDriverDatabase` re-declares shapes from drizzle-spanner with drift: `updateSchema` identical to `SpannerDriverDatabaseWithDdl['updateSchema']`; run request lacks `json?: boolean` (forces the `as never` in W11) | Compose from published types: run request compatible with `SpannerSqlRequest` + `Pick<SpannerDriverDatabaseWithDdl, 'updateSchema'>`. Minimum viable: just add `json?: boolean` (= W11) |
| T4 | packages/drizzle-spanner-kit/src/serializer.ts | 147 | low | 0.85 | Inline `{ parent: string; onDelete: ... } \| null` duplicates `TableEntity['interleave']` | Type as `TableEntity['interleave']` or name the shape in snapshot.ts |

---

## Needs review (confidence < 0.7 — never auto-applied)

| # | Agent | File | Lines | Conf | Issue / context |
|---|-------|------|-------|------|-----------------|
| R1 | defensive | packages/drizzle-spanner-kit/src/migrations.ts | 20–25 | 0.65 | `listMigrationFolders` catches ALL readdir errors and returns `[]`; EACCES/ENOTDIR silently present as "no migrations". Fix: return `[]` only on `ENOENT`, rethrow otherwise. Plausibly intentional for first-run `generate`. |
| R2 | dedup | packages/drizzle-spanner-kit/src/differ.ts | 535–562 | 0.60 | FK-diff and check-constraint-diff loops structurally identical; could extract generic `diffConstraints(...)`. Current code is clear — borderline abstraction. |
| R3 | dedup | src/migrator.ts | 25–31 | 0.60 | `escapeIdentifier`/`escapeString` exist in 3 copies (migrator.ts, dialect.ts SpannerDialect methods, kit ddl.ts). Kit copy crosses a package boundary and may be deliberate. |
| R4 | dedup | src/migrator.ts | 33–38 | 0.50 | `toStatements()` repeats normalization in kit `splitSqlStatements` — moot if U2 (delete splitSqlStatements) is applied. |
| R5 | dedup | src/columns/int64.ts | 31–36, 76–81 | 0.65 | `generatedAsIdentity()` duplicated verbatim in two builders in the same file. Low value unless touching the file anyway. |
| R6 | dedup+types | tests/unit/{runtime,session,rqb}.test.ts | various | 0.60–0.70 | Six fake-driver factories repeat the runTransactionAsync overload-dispatch + no-op transaction stub (~120–150 lines). Fix: shared tests/unit/fakes.ts. Per-test divergence may be deliberate. |
| R7 | weak-types | src/table.ts + ~15 sites | 19 | 0.70 | `SpannerColumn<any>` as the "any column" type matches drizzle-orm's own convention; optional cosmetic `AnySpannerColumn` alias. |
| R8 | slop | examples/basic-crud/src/main.ts | 37, 41, 66 | 0.50 | `// Read.` / `// Update.` / `// Delete.` markers — read as intentional tutorial walkthrough headings. Recommendation: keep. |
| R9 | slop | packages/drizzle-spanner-kit/src/differ.ts | 351 | 0.40 | `// Sequences.` phase marker — part of a consistent section-marker scheme. Recommendation: keep. |

---

## Clean bills of health

- **Legacy (agent 6):** zero findings. No deprecation markers, dead flags, old-shape branches, or compat shims anywhere. (Observation: root requires Node >=20, kit requires >=22.18 — intentional per-package, kit needs native TS module loading.)
- **AI slop (agent 7):** zero actionable findings. No stubs, TODOs, commented-out code, narrating comments (outside R8/R9), or over-nesting; guard clauses already used throughout.
- **Defensive (agent 5):** zero actionable findings. All catches are genuine trust boundaries or transform errors into domain errors; only R1 is marginal.
- **Unused deps:** none — knip clean, eslint no-unused-vars clean.

## Application status

Applied on branch `deslop/2026-07-30` (one commit per category, merged in precedence order; build + typecheck + tests green after every merge, lint green on the final state):

- **Applied — unused (U1–U9, U11, U12):** commit `9f1ae75`. Every deletion re-verified by grep before applying.
- **Applied — U10:** folded into the dedup commit — `applyDdl` became a non-exported delegator.
- **Applied — dedup (D1, D2, D3):** commit `a3c6b02`. New shared `applyDdlStatements` (+ `SpannerDdlClient` type) exported from `drizzle-spanner/migrator`; both callers' error wordings preserved. `orderTablesParentsFirst` (with cycle guard) moved to entities.ts after verifying the two orderings were behaviorally identical.
- **Applied — types (T1–T4) + W11–W13:** commit `5a288c2`. `KitDriverDatabase` now composed from published types (`SpannerDriverDatabase & Pick<SpannerDriverDatabaseWithDdl, 'updateSchema'> & { run(KitSqlRequest); close() }`); all three bridge casts deleted.
- **Applied — weak-types (W1–W10, W14–W19):** commit `650b21b`. Two casts kept deliberately: the inner polymorphic-this cast in `array()` (W3) and `params.extras as never` (W6, now commented).
- **Deferred — needs-review items R1–R9:** quarantined below 0.7 confidence, not applied. R4 is now moot (`splitSqlStatements` deleted by U2).
- **Follow-up noted, not acted on:** possible gap in the InterleaveBuilder type-level PK-prefix check (agent 4 side note under W15).
