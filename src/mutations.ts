import { is } from 'drizzle-orm/entity';
import { Param, SQL, StringChunk } from 'drizzle-orm/sql';
import { SpannerColumn } from './columns/common.js';
import type { SpannerDialect } from './dialect.js';
import { SpannerInvalidArgumentError } from './errors.js';
import type { SpannerTable } from './table.js';
import { getPrimaryKeyColumns } from './table.js';
import { TableColumns, TableName } from './symbols.js';

/**
 * Buffered-mutation writer, satisfied structurally by the driver's
 * `Transaction`: mutations buffer on it until commit.
 */
export interface SpannerMutationSink {
  insert(table: string, rows: Record<string, unknown>[]): void;
  update(table: string, rows: Record<string, unknown>[]): void;
  deleteRows(table: string, keys: unknown[][]): void;
}

/** Reads have no mutation form; thrown by every read path in mutation mode. */
export const MUTATION_MODE_READ_MESSAGE =
  'Reads are not allowed inside a bufferedMutations transaction; use a read-write or read-only transaction for queries';

/** Mutations return nothing; thrown when `.returning()` reaches mutation mode. */
export const MUTATION_MODE_RETURNING_MESSAGE =
  'returning() is not available inside a bufferedMutations transaction: mutations return nothing; use a read-write transaction';

/** The write-site value of `commitTimestamp()` in a mutation. */
const MUTATION_COMMIT_TIMESTAMP = 'spanner.commit_timestamp()';
const COMMIT_TIMESTAMP_SQL = 'PENDING_COMMIT_TIMESTAMP()';

function mutationValue(
  dialect: SpannerDialect,
  table: SpannerTable,
  fieldName: string,
  value: Param | SQL,
): unknown {
  if (is(value, Param)) {
    if (value.value === null) return null;
    const encoder = value.encoder as { mapToDriverValue?: (value: unknown) => unknown };
    return encoder.mapToDriverValue ? encoder.mapToDriverValue(value.value) : value.value;
  }
  // The only SQL expression a mutation can carry is the commit-timestamp
  // sentinel; mutations are key-addressed writes, not statements.
  if (dialect.sqlToQuery(value).sql === COMMIT_TIMESTAMP_SQL) {
    return MUTATION_COMMIT_TIMESTAMP;
  }
  throw new SpannerInvalidArgumentError({
    message: `Cannot write an SQL expression to column "${fieldName}" of table "${table[TableName]}" in a bufferedMutations transaction: mutations cannot evaluate SQL; use a read-write transaction`,
  });
}

/** Maps builder values (`Param` | `SQL` per field) to a driver mutation row keyed by cased column names. */
export function toMutationRow(
  dialect: SpannerDialect,
  table: SpannerTable,
  values: Record<string, Param | SQL>,
): Record<string, unknown> {
  const columns = table[TableColumns];
  const row: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(values)) {
    const column = columns[fieldName]!;
    row[dialect.casing.getColumnCasing(column)] = mutationValue(dialect, table, fieldName, value);
  }
  return row;
}

function isNoiseChunk(chunk: unknown): boolean {
  return is(chunk, StringChunk) && ['', '(', ')'].includes(chunk.value.join('').trim());
}

function chunkText(chunk: unknown): string | undefined {
  return is(chunk, StringChunk) ? chunk.value.join('').trim() : undefined;
}

/**
 * Extracts `column = value` pairs from a WHERE that is exactly an equality
 * or an `and(...)` of equalities on the given table's columns. Returns
 * undefined for any other shape — mutations are key-addressed, so only
 * exact-key predicates translate.
 */
function extractEqualities(
  where: SQL,
  table: SpannerTable,
  into: Map<SpannerColumn<any>, unknown>,
): boolean {
  const chunks = where.queryChunks.filter((chunk) => !isNoiseChunk(chunk));
  // Shape 1: a single binary equality — [Column, ' = ', Param].
  if (chunks.length === 3 && is(chunks[0], SpannerColumn) && chunkText(chunks[1]) === '=') {
    const column = chunks[0];
    const value = chunks[2];
    if (!is(value, Param) || (column.table as unknown) !== (table as unknown)) {
      return false;
    }
    into.set(column, value.value === null ? null : column.mapToDriverValue(value.value));
    return true;
  }
  // Shape 2: nested SQL nodes joined by 'and'.
  if (chunks.length === 0) return false;
  let expectSql = true;
  for (const chunk of chunks) {
    if (expectSql) {
      if (!is(chunk, SQL) || !extractEqualities(chunk, table, into)) return false;
    } else if (chunkText(chunk) !== 'and') {
      return false;
    }
    expectSql = !expectSql;
  }
  return !expectSql;
}

/**
 * Resolves a WHERE clause into the primary-key values it addresses, in key
 * order. Throws the spec'd typed error unless the WHERE is an exact equality
 * match on every primary-key column and nothing else.
 */
export function whereToPrimaryKey(
  table: SpannerTable,
  where: SQL | undefined,
  operation: 'update' | 'delete',
): { columns: SpannerColumn<any>[]; values: unknown[] } {
  const tableName = table[TableName];
  const explain = `${operation} in a bufferedMutations transaction is key-addressed: the WHERE must be an exact equality match on every primary-key column of "${tableName}"`;
  const equalities = new Map<SpannerColumn<any>, unknown>();
  if (!where || !extractEqualities(where, table, equalities)) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; got ${where ? 'a predicate that is not an and() of column equalities' : 'no WHERE clause'}`,
    });
  }
  const keyColumns = getPrimaryKeyColumns(table);
  const missing = keyColumns.filter((column) => !equalities.has(column));
  if (missing.length > 0) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; missing: ${missing.map((column) => column.name).join(', ')}`,
    });
  }
  const extras = [...equalities.keys()].filter((column) => !keyColumns.includes(column));
  if (extras.length > 0) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; non-key columns in WHERE: ${extras.map((column) => column.name).join(', ')}`,
    });
  }
  return {
    columns: keyColumns,
    values: keyColumns.map((column) => equalities.get(column)),
  };
}
