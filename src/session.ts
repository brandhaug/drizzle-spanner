import { entityKind } from 'drizzle-orm/entity'
import { type Logger } from 'drizzle-orm/logger'
import { NoopLogger } from 'drizzle-orm/logger'
import { type PreparedQuery } from 'drizzle-orm/session'
import { type Query, type SQL } from 'drizzle-orm/sql'
import { fillPlaceholders } from 'drizzle-orm/sql'
import { type SpannerDialect, type SpannerQueryWithTypings } from './dialect.js'
import { wrapSpannerError } from './errors.js'
import { type SpannerMutationSink } from './mutations.js'
import { type SpannerTimestampBounds } from './staleness.js'
import { type SelectedFieldsOrdered } from './orm-internal.js'
import { mapResultRow } from './orm-internal.js'
import { toDriverParamType } from './type-hints.js'

export const NO_CLIENT_MESSAGE =
  'Cannot execute a query on a mock database: no client is attached'

/** Minimal surface of `@google-cloud/spanner`'s request this adapter sends. */
export interface SpannerSqlRequest {
  sql: string
  params: Record<string, unknown>
  types: Record<string, unknown>
  json?: boolean
}

/** A driver row in array mode: one `{ name, value }` cell per selected field. */
export type SpannerDriverRow = { name: string; value: unknown }[] & {
  toJSON?: (options?: { wrapNumbers?: boolean }) => Record<string, unknown>
}

/**
 * A driver row as a mutable object keyed by selection alias. `toJSON` with
 * `wrapNumbers` converts nested STRUCT / ARRAY<STRUCT> values to plain
 * objects while keeping the driver's number wrappers, so drizzle's column
 * decoders see the same cell values as the flat row path.
 */
export function driverRowToObject(row: SpannerDriverRow): Record<string, unknown> {
  if (row.toJSON) return row.toJSON({ wrapNumbers: true })
  return Object.fromEntries(row.map((cell) => [cell.name, cell.value]))
}

/**
 * Where a statement executes. Reads run on `database.run`; DML must run inside
 * `runTransactionAsync` (the Node client's `run` is read-only). Inside
 * `db.transaction` both run on the one open driver transaction. A staleness
 * bound turns a read into a single-use bounded read — only the plain database
 * runner accepts one; transaction runners throw typed errors.
 */
export interface SpannerQueryRunner {
  run(
    request: SpannerSqlRequest,
    isDml: boolean,
    staleness?: SpannerTimestampBounds
  ): Promise<SpannerDriverRow[]>
}

export interface SpannerSessionOptions {
  logger?: Logger
}

export interface SpannerQueryMetadata {
  type: 'select' | 'insert' | 'update' | 'delete'
  /** Encoded timestamp bound of a `withStaleness` single-use read. */
  staleness?: SpannerTimestampBounds
}

/** Converts drizzle's positional params to Spanner named params plus type hints. */
export function toNamedParams(
  params: unknown[],
  typings: string[] | undefined
): { named: Record<string, unknown>; types: Record<string, unknown> } {
  const named: Record<string, unknown> = {}
  const types: Record<string, unknown> = {}
  for (const [i, value] of params.entries()) {
    named[`p${i}`] = value
    const typing = typings?.[i]
    const driverType = typing === undefined ? undefined : toDriverParamType(typing)
    if (driverType !== undefined) {
      types[`p${i}`] = driverType
    }
  }
  return { named, types }
}

const DML_PATTERN = /^\s*(insert|update|delete)/i

export class SpannerPreparedQuery<T = unknown> implements PreparedQuery {
  static readonly [entityKind]: string = 'SpannerPreparedQuery'

  constructor(
    private readonly runner: SpannerQueryRunner,
    private readonly queryWithTypings: SpannerQueryWithTypings,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly customResultMapper?: (rows: unknown[][]) => T,
    private readonly queryMetadata?: SpannerQueryMetadata,
    /** Relational queries map whole driver rows (nested STRUCTs), not cell arrays. */
    private readonly rawRowMapper?: (rows: Record<string, unknown>[]) => T
  ) {}

  getQuery(): Query {
    return this.queryWithTypings
  }

  mapResult(response: unknown): unknown {
    return response
  }

  async execute(placeholderValues: Record<string, unknown> = {}): Promise<T> {
    const params = fillPlaceholders(this.queryWithTypings.params, placeholderValues)
    this.logger.logQuery(this.queryWithTypings.sql, params)
    const { named, types } = toNamedParams(
      params,
      this.queryWithTypings.typings as string[] | undefined
    )
    const request: SpannerSqlRequest = {
      sql: this.queryWithTypings.sql,
      params: named,
      types
    }
    const isDml = this.queryMetadata
      ? this.queryMetadata.type !== 'select'
      : DML_PATTERN.test(this.queryWithTypings.sql)

    let rawRows: SpannerDriverRow[]
    try {
      rawRows = await this.runner.run(request, isDml, this.queryMetadata?.staleness)
    } catch (error) {
      throw wrapSpannerError(error, {
        sql: this.queryWithTypings.sql,
        paramNames: Object.keys(named),
        paramColumns: this.queryWithTypings.paramColumns
      })
    }

    if (this.rawRowMapper) {
      return this.rawRowMapper(rawRows.map(driverRowToObject))
    }
    if (!this.fields && !this.customResultMapper) {
      return rawRows.map((row) => (row.toJSON ? row.toJSON() : row)) as T
    }
    // Array row mode: cells arrive as { name, value } in select order.
    const rows = rawRows.map((row) => row.map((cell) => cell.value))
    if (this.customResultMapper) return this.customResultMapper(rows)
    return rows.map((row) => mapResultRow(this.fields!, row, undefined)) as T
  }
}

export class SpannerSession {
  static readonly [entityKind]: string = 'SpannerSession'

  /** @internal */
  readonly logger: Logger

  constructor(
    /** @internal */
    readonly runner: SpannerQueryRunner,
    /** @internal */
    readonly dialect: SpannerDialect,
    /** @internal */
    readonly options: SpannerSessionOptions = {},
    /** @internal Set only inside a bufferedMutations transaction. */
    readonly mutationSink?: SpannerMutationSink
  ) {
    this.logger = options.logger ?? new NoopLogger()
  }

  prepareQuery<T = unknown>(
    query: SpannerQueryWithTypings,
    fields: SelectedFieldsOrdered | undefined,
    customResultMapper?: (rows: unknown[][]) => T,
    queryMetadata?: SpannerQueryMetadata
  ): SpannerPreparedQuery<T> {
    return new SpannerPreparedQuery(
      this.runner,
      query,
      this.logger,
      fields,
      customResultMapper,
      queryMetadata
    )
  }

  /** Prepares a relational query whose rows decode as whole objects (nested STRUCTs). */
  prepareRelationalQuery<T = unknown>(
    query: SpannerQueryWithTypings,
    mapper: (rows: Record<string, unknown>[]) => T
  ): SpannerPreparedQuery<T> {
    return new SpannerPreparedQuery(
      this.runner,
      query,
      this.logger,
      undefined,
      undefined,
      { type: 'select' },
      mapper
    )
  }

  execute<T = unknown>(query: SQL): Promise<T> {
    return this.prepareQuery<T>(this.dialect.sqlToQuery(query), undefined).execute()
  }
}
