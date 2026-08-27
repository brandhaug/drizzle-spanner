import { entityKind, is } from 'drizzle-orm/entity'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { type Query, type SQLWrapper } from 'drizzle-orm/sql'
import { Param, SQL } from 'drizzle-orm/sql'
import { type SpannerDialect } from '../dialect.js'
import { type SelectedFieldsOrdered } from '../orm-internal.js'
import { orderSelectedFields } from '../orm-internal.js'
import { SpannerInvalidArgumentError } from '../errors.js'
import { type SpannerMutationSink } from '../mutations.js'
import {
  MUTATION_MODE_READ_MESSAGE,
  MUTATION_MODE_RETURNING_MESSAGE
} from '../mutations.js'
import {
  type SpannerPreparedQuery,
  type SpannerQueryMetadata,
  type SpannerSession
} from '../session.js'
import { NO_CLIENT_MESSAGE } from '../session.js'
import { type SpannerTimestampBounds } from '../staleness.js'
import { type SpannerColumns, type SpannerTable } from '../table.js'
import { TableColumns } from '../symbols.js'
import { type SpannerSelectedFields } from './select.js'

/** Wraps plain values in `Param` bound to their table column; SQL passes through. */
export function mapRowToParams(
  columns: SpannerColumns,
  row: Record<string, unknown>
): Record<string, Param | SQL> {
  const mapped: Record<string, Param | SQL> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue
    mapped[key] = is(value, SQL) ? value : new Param(value, columns[key])
  }
  return mapped
}

/**
 * Shared executable-query shape of the four builders: compile via `getSQL()`,
 * prepare against the session (or throw the mock guard), execute.
 */
export abstract class SpannerQueryBase<TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerQueryBase'

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult }

  /** Set by `SpannerSelect.withStaleness`; undefined for every other builder. */
  protected stalenessBounds: SpannerTimestampBounds | undefined

  constructor(
    private readonly session: SpannerSession | undefined,
    protected readonly dialect: SpannerDialect,
    private readonly queryType: SpannerQueryMetadata['type']
  ) {
    super()
  }

  /** @internal */
  abstract getSQL(): SQL

  /** The selection rows map through; undefined for DML without `.returning()`. */
  protected abstract selection(): SelectedFieldsOrdered | undefined

  toSQL(): Query {
    const { sql, params } = this.dialect.sqlToQuery(this.getSQL())
    return { sql, params }
  }

  /** @internal */
  _prepare(): SpannerPreparedQuery<TResult> {
    if (!this.session) {
      throw new Error(NO_CLIENT_MESSAGE)
    }
    const fields = this.selection()
    return this.session.prepareQuery<TResult>(
      this.dialect.sqlToQuery(this.getSQL()),
      fields,
      fields ? undefined : () => undefined as TResult,
      { type: this.queryType, staleness: this.stalenessBounds }
    )
  }

  /**
   * Buffers this query as a Spanner mutation. The DML builders override it;
   * the default covers reads, which have no mutation form.
   */
  protected writeMutation(_sink: SpannerMutationSink): void {
    throw new SpannerInvalidArgumentError({ message: MUTATION_MODE_READ_MESSAGE })
  }

  override execute(): Promise<TResult> {
    const sink = this.session?.mutationSink
    if (sink) {
      this.writeMutation(sink)
      return Promise.resolve(undefined as TResult)
    }
    return this._prepare().execute()
  }
}

/** Config shape the three DML builders share; each adds its own value fields. */
export interface SpannerDmlConfig {
  table: SpannerTable
  returning?: SelectedFieldsOrdered
}

/**
 * Shared DML shape: `returning()` selection handling and the mutation-mode
 * `.returning()` guard live here; the builders keep only their typed
 * `returning()` overloads and their mutation compilation.
 */
export abstract class SpannerDmlBase<TResult> extends SpannerQueryBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerDmlBase'

  protected abstract readonly config: SpannerDmlConfig

  /** Shared body of the builders' `returning()` overloads. */
  protected setReturning(
    fields: SpannerSelectedFields = this.config.table[TableColumns]
  ): this {
    this.config.returning = orderSelectedFields(fields)
    return this
  }

  protected selection(): SelectedFieldsOrdered | undefined {
    return this.config.returning
  }

  /** Runtime backstop for `.returning()` inside a bufferedMutations transaction. */
  protected assertNoReturningInMutation(): void {
    if (this.config.returning) {
      throw new SpannerInvalidArgumentError({
        message: MUTATION_MODE_RETURNING_MESSAGE
      })
    }
  }
}

/** DML that takes a WHERE clause: update and delete. */
export abstract class SpannerFilteredDmlBase<TResult> extends SpannerDmlBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerFilteredDmlBase'

  protected abstract override readonly config: SpannerDmlConfig & { where?: SQL }

  where(where: SQL | undefined): this {
    this.config.where = where
    return this
  }
}
