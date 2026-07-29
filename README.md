# drizzle-spanner

Experiments with Drizzle ORM against Google Cloud Spanner.

## Context

- Spanner has two dialects, chosen at database creation: GoogleSQL and PostgreSQL.
- Drizzle has no native Spanner dialect. The supported path is the PostgreSQL dialect via [PGAdapter](https://github.com/GoogleCloudPlatform/pgadapter) (data operations only — no `drizzle-kit` migrations, no Relational Queries API).
- Our production databases (`strise-prod`) use GoogleSQL, so this repo explores what is feasible for that dialect.

## References

- [Drizzle discussion #2439 — Spanner support](https://github.com/drizzle-team/drizzle-orm/discussions/2439)
- [PGAdapter Drizzle docs](https://github.com/GoogleCloudPlatform/pgadapter/blob/postgresql-dialect/docs/drizzle.md)
- [Getting Gemini to write an ORM for Spanner in a weekend](https://suyogs.com/p/getting-gemini-to-write-an-orm-for-spanner-in-a-weekend/)
