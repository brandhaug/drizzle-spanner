# Prior art: Spanner ORM adapters and Drizzle Spanner discussions

Resolves issue #5. Date: 2026-07-29.

This document surveys earlier work on Cloud Spanner support in ORMs and query builders. It records what we can learn or reuse for a Drizzle Spanner dialect.

## Background: Spanner constraints that shape every adapter

- Spanner offers two write paths: DML statements and mutations ([docs](https://docs.cloud.google.com/spanner/docs/dml-versus-mutations)).
- DML gives read-your-writes inside a transaction. Mutations buffer client-side until commit and do not.
- Spanner aborts transactions under contention. The client must retry the whole transaction.
- Spanner supports interleaved tables. A child table is stored inside its parent row via `INTERLEAVE IN PARENT`.
- DDL is not transactional. Spanner batches DDL statements in one long-running operation.
- Tables have no auto-increment. Clients use UUIDs or bit-reversed sequences for keys.

## JS/TS ecosystem

### Prisma — never started

- Feature request [prisma/prisma#717](https://github.com/prisma/prisma/issues/717) opened in October 2019. Prisma closed it as not planned.
- Cause: Prisma requires a full native connector per database. Spanner never made the roadmap.
- The only path is Spanner's PostgreSQL dialect through [PGAdapter](https://github.com/GoogleCloudPlatform/pgadapter). That path breaks Prisma Migrate. PGAdapter has no DDL transactions and an incomplete `pg_catalog` ([pgadapter#581](https://github.com/GoogleCloudPlatform/pgadapter/issues/581)).
- Interleaved tables: not expressible. Mutations: not available over the wire protocol. Retries: none, Prisma sees a generic Postgres error.

### TypeORM — official driver, effectively stalled

- A core maintainer merged a `spanner` driver in April 2022 ([PR #8730](https://github.com/typeorm/typeorm/pull/8730)). It builds on `@google-cloud/spanner`. Docs: [typeorm.io/docs/drivers/google-spanner](https://typeorm.io/docs/drivers/google-spanner/).
- Interleaved tables: not modeled. Relations use foreign keys only.
- Writes use DML only. The driver does not use the mutation API.
- Retries: no automatic ABORTED retry at the ORM layer.
- Migrations are broken. The migrations bookkeeping table needs auto-increment ids, which Spanner lacks ([typeorm#9725](https://github.com/typeorm/typeorm/issues/9725), closed as not planned).
- Cause of stall: no maintainer engagement since 2022. Treat it as maintained in name only.

### Knex — never started

- Knex core has no Spanner dialect ([knexjs.org](https://knexjs.org/guide/)). No `knex-spanner` package exists on npm.
- Cause: Spanner's client is not a callback-style SQL driver. Knex's third-party dialect API is poorly documented ([knex#5836](https://github.com/knex/knex/issues/5836)).

### Kysely — never started

- No Spanner dialect exists in core, in [awesome-kysely](https://github.com/kysely-org/awesome-kysely), or on npm.
- Kysely's [`Dialect` interface](https://kysely-org.github.io/kysely-apidoc/interfaces/Dialect.html) is small: driver, query compiler, introspector, adapter. It is the most tractable greenfield target, but nobody built it.

### MikroORM — never started, architecturally blocked

- Request [mikro-orm#430](https://github.com/mikro-orm/mikro-orm/issues/430) opened in March 2020. It closed without implementation.
- Cause: all MikroORM SQL drivers sit on Knex. Knex has no Spanner support.

### @google-cloud/spanner Node.js client (the substrate)

- The client supports both DML (`runUpdate`, `batchUpdate`) and mutations (`transaction.insert`, `table.upsert`) ([npm](https://www.npmjs.com/package/@google-cloud/spanner)).
- `database.runTransactionAsync` retries the callback on ABORTED. A dialect must route its unit of work through this runner.
- `database.updateSchema(ddl)` applies batched DDL as a long-running operation. This is the natural migration target.
- The client imposes no barrier to interleaved tables. Interleaving is pure DDL. The JS ORMs simply never modeled it.

## Other ecosystems

### Go

- [go-sql-spanner](https://github.com/googleapis/go-sql-spanner) (official `database/sql` driver): DML-first. It exposes mutations via connection unwrap. It retries aborts internally (`retryAbortsInternally`). It supports `START BATCH DDL` / `RUN BATCH` and stale-read session statements.
- [go-gorm-spanner](https://github.com/googleapis/go-gorm-spanner) (official, GA): `AutoMigrate` cannot create interleaved tables. Google recommends manual DDL. `AutoMigrateDryRun` returns the DDL for review before execution. Nested transactions are unsupported.
- [yo](https://github.com/cloudspannerecosystem/yo) (community): mutation-first code generator from DDL. Not officially supported.

### Java

- [google-cloud-spanner-hibernate](https://github.com/GoogleCloudPlatform/google-cloud-spanner-hibernate) (official): models interleaving with an `@Interleaved` annotation plus composite PKs (`@IdClass`/`@EmbeddedId`). It uses DML only. Aborted-transaction retries live in the JDBC driver, not in Hibernate.
- Spring Data Cloud Spanner: builds on the native client. Template writes use the mutation API. `@Interleaved` is the only relationship annotation. `SpannerSchemaUtils` generates DDL.

### Ruby — the best reference design

- [ruby-spanner-activerecord](https://github.com/googleapis/ruby-spanner-activerecord) (official) has the richest design.
- Migration DSL: `t.interleave_in :parent, :cascade` with composite PKs.
- Explicit mutation mode: `transaction(isolation: :buffered_mutations)`. Writes buffer until commit with no read-your-writes. Implicit single-statement transactions use mutations automatically.
- DDL batching: `connection.ddl_batch do ... end`.
- GoogleSQL dialect only.

### Python — both adapters archived

- [python-spanner-django](https://github.com/googleapis/python-spanner-django): archived June 2026 (code moved to the google-cloud-python monorepo). Interleaved tables unsupported. DML only. Cause of slow cadence: Django LTS-only support policy.
- sqlalchemy-spanner ([now in google-cloud-python](https://github.com/googleapis/google-cloud-python/tree/main/packages/sqlalchemy-spanner)): interleaving via dialect kwargs (`spanner_interleave_in` plus `add_is_dependent_on()`). DML only. `THEN RETURN` is unsupported with Batch DML, so client-side UUID PKs are recommended. Aborted transactions retry automatically via checksum replay. Alembic works with `version_table_pk=False`.

## Drizzle-orm issues, discussions, and PRs

- [Issue #248](https://github.com/drizzle-team/drizzle-orm/issues/248) "Support for Google Cloud Spanner": closed, converted to Discussion #2439 in June 2024.
- [Issue #693](https://github.com/drizzle-team/drizzle-orm/issues/693): closed as duplicate of #248.
- [Discussion #2439](https://github.com/drizzle-team/drizzle-orm/discussions/2439): open, 7 comments, no maintainer response. Key threads:
  - PGAdapter route: run the stock pg dialect against Spanner-pg. One user posted a working `patch-package` diff. Documented blockers: no schema support, no leading `__` table names, no SERIAL, no DDL in transactions, no named PK constraints, no `DO $$` blocks.
  - One user gave up on pg-compat (missing functions such as `ilike`) and built a separate ORM instead.
  - One user showed a working private Drizzle-Spanner integration in February 2026. No repo link surfaced.
- [PR #4269](https://github.com/drizzle-team/drizzle-orm/pull/4269) "Preview/spanner googlesql": external WIP, opened and closed in March 2025 (wrong target branch), never resubmitted. Approach: clone `mysql-core` into a new `googlesql` dialect, add GoogleSQL column types and a Spanner driver, add drizzle-kit config. The fork branch survives: [dotcom-dev/drizzle-orm#preview/spanner-googlesql](https://github.com/dotcom-dev/drizzle-orm/tree/preview/spanner-googlesql).
- Drizzle has no public third-party dialect API. Dialects live inside the monorepo. Precedent for a new dialect is in-repo cloning (SingleStore from `mysql-core`, Gel from `pg-core`).
- Community: [Flux159/spanner-orm](https://github.com/Flux159/spanner-orm) is a standalone Drizzle-inspired TypeScript ORM for GoogleSQL and Postgres. It is not a Drizzle dialect.

## Comparison table

| Project | Status | Interleaved tables | Mutations vs DML | Transaction retries | Migrations | Stall cause |
|---|---|---|---|---|---|---|
| [Prisma](https://github.com/prisma/prisma/issues/717) | Never started | No | DML only (via PGAdapter) | No | Broken via PGAdapter | Closed as not planned; connector cost |
| [TypeORM](https://typeorm.io/docs/drivers/google-spanner/) | Official, stalled | No | DML only | No | Broken ([#9725](https://github.com/typeorm/typeorm/issues/9725)) | No maintainer engagement since 2022 |
| Knex | Never started | — | — | — | — | Client-driver mismatch; weak dialect API |
| Kysely | Never started | — | — | — | — | Nobody built it |
| [MikroORM](https://github.com/mikro-orm/mikro-orm/issues/430) | Never started | — | — | — | — | Blocked on Knex |
| [go-sql-spanner](https://github.com/googleapis/go-sql-spanner) | Official, active | DDL passthrough | Both (unwrap for mutations) | Internal auto-retry | Batch DDL statements | — |
| [go-gorm-spanner](https://github.com/googleapis/go-gorm-spanner) | Official, GA | Manual DDL only | DML (driver default) | Via driver | Dry-run DDL; no interleave | — |
| [Hibernate adapter](https://github.com/GoogleCloudPlatform/google-cloud-spanner-hibernate) | Official, active | `@Interleaved` annotation | DML only | Via JDBC driver | DDL generation | — |
| Spring Data Spanner | Official | `@Interleaved` | Mutations for template writes | Via client | `SpannerSchemaUtils` DDL | — |
| [ruby-spanner-activerecord](https://github.com/googleapis/ruby-spanner-activerecord) | Official, active | Migration DSL `interleave_in` | Both; explicit mutation mode | Via client | `ddl_batch` blocks | — |
| [python-spanner-django](https://github.com/googleapis/python-spanner-django) | Archived 2026 | No | DML only | Via client | Django migrations, partial | Django LTS cadence; monorepo move |
| sqlalchemy-spanner | Active (monorepo) | Dialect kwargs | DML only | Checksum replay auto-retry | Alembic, `version_table_pk=False` | — |
| [Drizzle PR #4269](https://github.com/drizzle-team/drizzle-orm/pull/4269) | Abandoned WIP | Unknown | Unknown | Unknown | drizzle-kit config started | Wrong branch; never resubmitted |
| [Flux159/spanner-orm](https://github.com/Flux159/spanner-orm) | Active, tiny | Yes (GoogleSQL) | DML | Via client | Own migrations CLI | — |

## Lessons for drizzle-spanner

1. Interleaved tables are the dividing line. Ruby's migration DSL and Hibernate's annotation are best in class. Copy the Ruby DSL shape for the schema builder.
2. Only Ruby offers a first-class mutation mode. Expose it as an explicit transaction option, as Ruby does. Do not mix mutations and DML in one transaction.
3. Every serious adapter pushes ABORTED retries into the driver or client layer. Route the unit of work through `database.runTransactionAsync` and keep the retry out of the query builder.
4. Batch DDL everywhere. Migrations must use `updateSchema` batches, not statement-by-statement execution.
5. Avoid auto-increment assumptions. The migrations bookkeeping table killed TypeORM's story. Use UUID or client-generated keys for the journal table.
6. GORM's `AutoMigrateDryRun` pattern (return DDL for review) is worth copying into drizzle-kit generate.
7. Drizzle has no plug-in dialect API. Viable routes: fork drizzle-orm and clone `mysql-core` (the PR #4269 pattern), target Spanner-pg via PGAdapter with the stock pg dialect plus workarounds, or ship a standalone package. The PGAdapter route has a documented blocker list in [discussion #2439](https://github.com/drizzle-team/drizzle-orm/discussions/2439).

## Sources

- https://docs.cloud.google.com/spanner/docs/dml-versus-mutations
- https://github.com/prisma/prisma/issues/717
- https://github.com/GoogleCloudPlatform/pgadapter
- https://github.com/typeorm/typeorm/pull/8730
- https://github.com/typeorm/typeorm/issues/9725
- https://github.com/kysely-org/awesome-kysely
- https://github.com/mikro-orm/mikro-orm/issues/430
- https://www.npmjs.com/package/@google-cloud/spanner
- https://github.com/googleapis/go-sql-spanner
- https://github.com/googleapis/go-gorm-spanner
- https://github.com/GoogleCloudPlatform/google-cloud-spanner-hibernate
- https://github.com/googleapis/ruby-spanner-activerecord
- https://github.com/googleapis/python-spanner-django
- https://github.com/googleapis/google-cloud-python/tree/main/packages/sqlalchemy-spanner
- https://github.com/drizzle-team/drizzle-orm/discussions/2439
- https://github.com/drizzle-team/drizzle-orm/pull/4269
- https://github.com/dotcom-dev/drizzle-orm/tree/preview/spanner-googlesql
- https://github.com/Flux159/spanner-orm
