import { entityKind } from 'drizzle-orm/entity'
import { type Logger } from 'drizzle-orm/logger'
import { NoopLogger } from 'drizzle-orm/logger'
import { type PreparedQuery } from 'drizzle-orm/session'
import { type Query, type SQL } from 'drizzle-orm/sql'
import { fillPlaceholders } from 'drizzle-orm/sql'
import { type SpannerDialect, type SpannerQueryWithTypings } from './dialect.js'
import { SpannerInvalidArgumentError, wrapSpannerError } from './errors.js'
import { type SpannerMutationSink } from './mutations.js'
import { type SpannerTimestampBounds } from './staleness.js'
import { type SelectedFieldsOrdered } from './orm-internal.js'
import { makeDefaultQueryMapper } from './orm-internal.js'
import { toDriverParamType } from './type-hints.js'

export const NO_CLIENT_MESSAGE =
  'Cannot execute a query on a mock database: no client is attached'

/** Spanner's request priority, as the driver's `requestOptions.priority` names it. */
export type SpannerDriverPriority = 'PRIORITY_LOW' | 'PRIORITY_MEDIUM' | 'PRIORITY_HIGH'

/** Minimal surface of `@google-cloud/spanner`'s request this adapter sends. */
export interface SpannerSqlRequest {
  sql: string
  params: Record<string, unknown>
  types: Record<string, unknown>
  json?: boolean
  requestOptions?: { requestTag?: string; priority?: SpannerDriverPriority }
}

/** Per-request options a query builder can set: `withRequestOptions`. */
export interface SpannerRequestOptions {
  /** Shows in Spanner's query statistics and lock insights as `request_tag`. */
  requestTag?: string
  /** Spanner's CPU scheduling priority for the request; Spanner's default is high. */
  priority?: 'low' | 'medium' | 'high'
}

/** How one statement runs besides its SQL: a single-use staleness bound and a cancellation signal. */
export interface SpannerRunOptions {
  staleness?: SpannerTimestampBounds
  signal?: AbortSignal
}

const DRIVER_PRIORITY: Record<
  NonNullable<SpannerRequestOptions['priority']>,
  SpannerDriverPriority
> = {
  low: 'PRIORITY_LOW',
  medium: 'PRIORITY_MEDIUM',
  high: 'PRIORITY_HIGH'
}

export function toDriverRequestOptions(
  options: SpannerRequestOptions | undefined
): SpannerSqlRequest['requestOptions'] {
  if (
    !options ||
    (options.requestTag === undefined && options.priority === undefined)
  ) {
    return undefined
  }
  const driverOptions: NonNullable<SpannerSqlRequest['requestOptions']> = {}
  if (options.requestTag !== undefined) {
    driverOptions.requestTag = options.requestTag
  }
  if (options.priority !== undefined) {
    driverOptions.priority = DRIVER_PRIORITY[options.priority]
  }
  return driverOptions
}

/** A driver row in array mode: one `{ name, value }` cell per selected field. */
export type SpannerDriverRow = Array<{ name: string; value: unknown }> & {
  toJSON?: (options?: { wrapNumbers?: boolean }) => Record<string, unknown>
}

/**
 * A driver row as a mutable object keyed by selection alias. `toJSON` with
 * `wrapNumbers` converts nested STRUCT / ARRAY<STRUCT> values to plain
 * objects while keeping the driver's number wrappers, so drizzle's column
 * decoders see the same cell values as the flat row path.
 */
export function driverRowToObject(row: SpannerDriverRow): Record<string, unknown> {
  if (row.toJSON) {
    return row.toJSON({ wrapNumbers: true })
  }
  return Object.fromEntries(row.map((cell) => [cell.name, cell.value]))
}

/**
 * Where a statement executes. Reads run on `database.run`; DML must run inside
 * `runTransactionAsync` (the Node client's `run` is read-only). Inside
 * `db.transaction` both run on the one open driver transaction. A staleness
 * bound turns a read into a single-use bounded read, and a signal makes it
 * cancellable — only the plain database runner accepts either; transaction
 * runners throw typed errors.
 */
export interface SpannerQueryRunner {
  run(
    request: SpannerSqlRequest,
    isDml: boolean,
    options?: SpannerRunOptions
  ): Promise<Array<SpannerDriverRow>>
}

export interface SpannerSessionOptions {
  logger?: Logger
}

export interface SpannerQueryMetadata {
  /** Absent for raw SQL, whose statement kind is read from its text. */
  type?: 'select' | 'insert' | 'update' | 'delete'
  /** Encoded timestamp bound of a `withStaleness` single-use read. */
  staleness?: SpannerTimestampBounds
  /** Set by `withRequestOptions`. */
  requestOptions?: SpannerRequestOptions
  /** Set by `withSignal`: aborting cancels the read. */
  signal?: AbortSignal
}

/** Converts drizzle's positional params to Spanner named params plus type hints. */
export function toNamedParams(
  params: Array<unknown>,
  typings: Array<string> | undefined
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

  private rowsMapper: ((rows: Array<Array<unknown>>) => Array<unknown>) | undefined

  constructor(
    private readonly runner: SpannerQueryRunner,
    private readonly queryWithTypings: SpannerQueryWithTypings,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly customResultMapper?: (rows: Array<Array<unknown>>) => T,
    private readonly queryMetadata?: SpannerQueryMetadata,
    /** Relational queries map whole driver rows (nested STRUCTs), not cell arrays. */
    private readonly rawRowMapper?: (rows: Array<Record<string, unknown>>) => T
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
      this.queryWithTypings.typings as Array<string> | undefined
    )
    const requestOptions = toDriverRequestOptions(this.queryMetadata?.requestOptions)
    const request: SpannerSqlRequest = {
      sql: this.queryWithTypings.sql,
      params: named,
      types
    }
    if (requestOptions) {
      request.requestOptions = requestOptions
    }
    const type = this.queryMetadata?.type
    const isDml = type ? type !== 'select' : DML_PATTERN.test(this.queryWithTypings.sql)

    let rawRows: Array<SpannerDriverRow>
    const signal = this.queryMetadata?.signal
    if (isDml && signal) {
      throw new SpannerInvalidArgumentError({
        message:
          'withSignal cancels reads; DML could commit after the abort, so it takes no signal'
      })
    }
    signal?.throwIfAborted()
    try {
      rawRows = await this.runner.run(request, isDml, {
        staleness: this.queryMetadata?.staleness,
        signal: this.queryMetadata?.signal
      })
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason
      }
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
    if (this.customResultMapper) {
      return this.customResultMapper(rows)
    }
    this.rowsMapper ??= makeDefaultQueryMapper(this.fields!, undefined)
    return this.rowsMapper(rows) as T
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
    customResultMapper?: (rows: Array<Array<unknown>>) => T,
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
    mapper: (rows: Array<Record<string, unknown>>) => T
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

  /** Raw SQL: rows arrive as the driver's `toJSON()` objects. */
  execute<T = unknown>(
    query: SQL,
    options: Pick<SpannerQueryMetadata, 'requestOptions' | 'signal'> = {}
  ): Promise<T> {
    return this.prepareQuery<T>(
      this.dialect.sqlToQuery(query),
      undefined,
      undefined,
      options
    ).execute()
  }
}
