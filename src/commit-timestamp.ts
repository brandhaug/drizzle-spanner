import { type SQL } from 'drizzle-orm/sql'
import { sql } from 'drizzle-orm/sql'

/**
 * Write-site sentinel for commit-timestamp columns: use in `values()` and
 * `set()` on a `timestamp(name, { allowCommitTimestamp: true })` column.
 * Compiles to `PENDING_COMMIT_TIMESTAMP()`; the value is unreadable until the
 * transaction commits, so statements writing it should come last in a
 * transaction.
 */
export function commitTimestamp(): SQL<Date> {
  return sql<Date>`PENDING_COMMIT_TIMESTAMP()`
}
