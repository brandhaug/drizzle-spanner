import { entityKind } from 'drizzle-orm/entity'
import { type DriverValueEncoder, Param, type SQL, sql } from 'drizzle-orm/sql'
import { type SpannerColumn } from './columns/common.js'
import { type SpannerTokenlist } from './columns/tokenlist.js'
import { type SpannerTypeHint, arrayTypeHint } from './type-hints.js'

/**
 * Binds an array of a column's values as one parameter: each element goes
 * through the column's encoder, and the parameter carries the column's
 * element type as an ARRAY type hint, so an empty array still binds.
 */
export class SpannerArrayParamEncoder implements DriverValueEncoder<
  Array<unknown>,
  Array<unknown>
> {
  static readonly [entityKind]: string = 'SpannerArrayParamEncoder'

  constructor(readonly column: SpannerColumn<any>) {}

  typeHint(): SpannerTypeHint {
    return arrayTypeHint(this.column.typeHint())
  }

  mapToDriverValue = (values: Array<unknown>): Array<unknown> =>
    values.map((value) => (value === null ? null : this.column.mapToDriverValue(value)))
}

/**
 * `column IN UNNEST(@p)`: the values bind as one ARRAY parameter. Unlike
 * `inArray`, which binds a parameter per value, the SQL text is the same for
 * any number of values, so Spanner reuses one cached plan, and the 950
 * parameter limit does not apply.
 */
export function inUnnest<TColumn extends SpannerColumn<any>>(
  column: TColumn,
  values: ReadonlyArray<TColumn['_']['data']>
): SQL<boolean> {
  return sql<boolean>`${column} in unnest(${new Param([...values], new SpannerArrayParamEncoder(column))})`
}

/** Spanner full-text search: `SEARCH(tokens, @query)` over a TOKENLIST column. */
export function search(tokens: SpannerTokenlist, query: string): SQL<boolean> {
  return sql<boolean>`search(${tokens}, ${query})`
}
