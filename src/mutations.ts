import { is } from 'drizzle-orm/entity'
import { Param, type SQL } from 'drizzle-orm/sql'
import { type SpannerDialect } from './dialect.js'
import { SpannerInvalidArgumentError } from './errors.js'
import { type SpannerTable } from './table.js'
import { TableColumns, TableName } from './symbols.js'

/**
 * Buffered-mutation writer, satisfied structurally by the driver's
 * `Transaction`: mutations buffer on it until commit.
 */
export interface SpannerMutationSink {
  insert(table: string, rows: Array<Record<string, unknown>>): void
  update(table: string, rows: Array<Record<string, unknown>>): void
  upsert(table: string, rows: Array<Record<string, unknown>>): void
  deleteRows(table: string, keys: Array<Array<unknown>>): void
}

/** Reads have no mutation form; thrown by every read path in mutation mode. */
export const MUTATION_MODE_READ_MESSAGE =
  'Reads are not allowed inside a bufferedMutations transaction; use a read-write or read-only transaction for queries'

/** Mutations return nothing; thrown when `.returning()` reaches mutation mode. */
export const MUTATION_MODE_RETURNING_MESSAGE =
  'returning() is not available inside a bufferedMutations transaction: mutations return nothing; use a read-write transaction'

/** The write-site value of `commitTimestamp()` in a mutation. */
const MUTATION_COMMIT_TIMESTAMP = 'spanner.commit_timestamp()'
const COMMIT_TIMESTAMP_SQL = 'PENDING_COMMIT_TIMESTAMP()'

function mutationValue(
  dialect: SpannerDialect,
  table: SpannerTable,
  fieldName: string,
  value: Param | SQL
): unknown {
  if (is(value, Param)) {
    if (value.value === null) {
      return null
    }
    const encoder = value.encoder as { mapToDriverValue?: (value: unknown) => unknown }
    return encoder.mapToDriverValue
      ? encoder.mapToDriverValue(value.value)
      : value.value
  }
  // The only SQL expression a mutation can carry is the commit-timestamp
  // sentinel; mutations are key-addressed writes, not statements.
  if (dialect.sqlToQuery(value).sql === COMMIT_TIMESTAMP_SQL) {
    return MUTATION_COMMIT_TIMESTAMP
  }
  throw new SpannerInvalidArgumentError({
    message: `Cannot write an SQL expression to column "${fieldName}" of table "${table[TableName]}" in a bufferedMutations transaction: mutations cannot evaluate SQL; use a read-write transaction`
  })
}

/** Maps builder values (`Param` | `SQL` per field) to a driver mutation row keyed by cased column names. */
export function toMutationRow(
  dialect: SpannerDialect,
  table: SpannerTable,
  values: Record<string, Param | SQL>
): Record<string, unknown> {
  const columns = table[TableColumns]
  const row: Record<string, unknown> = {}
  for (const [fieldName, value] of Object.entries(values)) {
    const column = columns[fieldName]!
    row[column.name] = mutationValue(dialect, table, fieldName, value)
  }
  return row
}

export { whereToPrimaryKey } from './mutation-keys.js'
