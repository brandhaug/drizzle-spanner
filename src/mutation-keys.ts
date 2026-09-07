import { is } from 'drizzle-orm/entity'
import { Param, Placeholder, SQL, StringChunk } from 'drizzle-orm/sql'
import { SpannerColumn } from './columns/common.js'
import { SpannerInvalidArgumentError } from './errors.js'
import { type SpannerTable, getPrimaryKeyColumns } from './table.js'
import { TableName } from './symbols.js'

function isNoiseChunk(chunk: unknown): boolean {
  return is(chunk, StringChunk) && ['', '(', ')'].includes(chunk.value.join('').trim())
}

function chunkText(chunk: unknown): string | undefined {
  return is(chunk, StringChunk) ? chunk.value.join('').trim() : undefined
}

/**
 * Extracts `column = value` pairs from a WHERE that is exactly an equality
 * or an `and(...)` of equalities on the given table's columns. Returns
 * false for any other shape. Each column must appear exactly once: collecting
 * repeated predicates into a map would discard part of the WHERE condition.
 */
function extractEqualities(
  where: SQL,
  table: SpannerTable,
  into: Map<SpannerColumn<any>, unknown>
): boolean {
  const chunks = where.queryChunks.filter((chunk) => !isNoiseChunk(chunk))
  // Shape 1: a single binary equality — [Column, ' = ', Param].
  if (
    chunks.length === 3 &&
    is(chunks[0], SpannerColumn) &&
    chunkText(chunks[1]) === '='
  ) {
    const column = chunks[0]
    const value = chunks[2]
    if (
      !is(value, Param) ||
      value.encoder !== column ||
      column.table !== table ||
      into.has(column) ||
      value.value === null ||
      value.value === undefined ||
      is(value.value, Placeholder) ||
      is(value.value, SQL)
    ) {
      return false
    }
    const mapped = column.mapToDriverValue(value.value)
    if (is(mapped, SQL)) {
      return false
    }
    into.set(column, mapped)
    return true
  }
  // Shape 2: nested SQL nodes joined by 'and'.
  if (chunks.length === 0) {
    return false
  }
  let expectSql = true
  for (const chunk of chunks) {
    if (expectSql) {
      if (!is(chunk, SQL) || !extractEqualities(chunk, table, into)) {
        return false
      }
    } else if (chunkText(chunk) !== 'and') {
      return false
    }
    expectSql = !expectSql
  }
  return !expectSql
}

/**
 * Resolves a WHERE clause into the primary-key values it addresses, in key
 * order. Throws the spec'd typed error unless the WHERE is an exact equality
 * match on every primary-key column and nothing else.
 */
export function whereToPrimaryKey(
  table: SpannerTable,
  where: SQL | undefined,
  operation: 'update' | 'delete'
): { columns: Array<SpannerColumn<any>>; values: Array<unknown> } {
  const tableName = table[TableName]
  const explain = `${operation} in a bufferedMutations transaction is key-addressed: the WHERE must be an exact equality match on every primary-key column of "${tableName}"`
  const equalities = new Map<SpannerColumn<any>, unknown>()
  if (!where || !extractEqualities(where, table, equalities)) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; got ${where ? 'a predicate that is not an and() of unique column equalities with concrete values' : 'no WHERE clause'}`
    })
  }
  const keyColumns = getPrimaryKeyColumns(table)
  const missing = keyColumns.filter((column) => !equalities.has(column))
  if (missing.length > 0) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; missing: ${missing.map((column) => column.name).join(', ')}`
    })
  }
  const extras = [...equalities.keys()].filter((column) => !keyColumns.includes(column))
  if (extras.length > 0) {
    throw new SpannerInvalidArgumentError({
      message: `${explain}; non-key columns in WHERE: ${extras.map((column) => column.name).join(', ')}`
    })
  }
  return {
    columns: keyColumns,
    values: keyColumns.map((column) => equalities.get(column))
  }
}
