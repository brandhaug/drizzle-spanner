import { entityKind } from 'drizzle-orm/entity'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { type Query, type SQL, type SQLWrapper } from 'drizzle-orm/sql'
import { type SpannerDialect } from '../dialect.js'
import { type SpannerRequestOptions, type SpannerSession } from '../session.js'

/**
 * Raw SQL inside a transaction. It has no `withSignal`: the driver may retry the
 * whole callback, so a transaction is cancelled as a whole.
 */
export interface SpannerTransactionRaw<TResult> extends Promise<TResult> {
  withRequestOptions(options: SpannerRequestOptions): this
  toSQL(): Query
  execute(): Promise<TResult>
}

/**
 * `db.execute(sql)`, the raw-SQL escape hatch. Rows arrive as the driver's
 * `toJSON()` objects. On the database a raw INSERT, UPDATE or DELETE runs in
 * its own read-write transaction, like the DML builders.
 */
export class SpannerRaw<TResult> extends QueryPromise<TResult> implements SQLWrapper {
  static override readonly [entityKind]: string = 'SpannerRaw'

  private requestOptions: SpannerRequestOptions | undefined
  private signal: AbortSignal | undefined

  constructor(
    private readonly query: SQL,
    private readonly session: SpannerSession,
    private readonly dialect: SpannerDialect
  ) {
    super()
  }

  /** Spanner's request tag, which names the statement in query statistics, and its CPU priority. */
  withRequestOptions(options: SpannerRequestOptions): this {
    this.requestOptions = options
    return this
  }

  /**
   * Cancels a raw read when the signal aborts; it rejects with the signal's
   * reason. Raw DML refuses a signal, because it could commit after the abort.
   */
  withSignal(signal: AbortSignal): this {
    this.signal = signal
    return this
  }

  /** @internal */
  getSQL(): SQL {
    return this.query
  }

  toSQL(): Query {
    const { sql, params } = this.dialect.sqlToQuery(this.query)
    return { sql, params }
  }

  override execute(): Promise<TResult> {
    return this.session.execute<TResult>(this.query, {
      requestOptions: this.requestOptions,
      signal: this.signal
    })
  }
}
