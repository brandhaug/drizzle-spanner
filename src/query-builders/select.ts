import { entityKind, is } from 'drizzle-orm/entity'
import { type Query, type SQL } from 'drizzle-orm/sql'
import { type Column, type GetColumnData } from 'drizzle-orm/column'
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy'
import { Subquery } from 'drizzle-orm/subquery'
import { type InferSelectModel } from 'drizzle-orm/table'
import { type SpannerColumn } from '../columns/common.js'
import {
  type SpannerDialect,
  type SpannerSelectConfig,
  type SpannerSetOperationConfig,
  type SpannerSetOperator
} from '../dialect.js'
import { type SelectedFieldsOrdered } from '../orm-internal.js'
import { orderSelectedFields } from '../orm-internal.js'
import { type SpannerRequestOptions, type SpannerSession } from '../session.js'
import { type SpannerStaleness } from '../staleness.js'
import { toTimestampBounds } from '../staleness.js'
import { type AnySpannerTable } from '../table.js'
import { TableColumns } from '../symbols.js'
import { type SpannerRequestState, SpannerQueryBase } from './query-base.js'
import { type SpannerSelectedFields } from './select-fields.js'

export type { SpannerSelectedFields } from './select-fields.js'

export type SelectResultField<T> =
  T extends Column<any>
    ? GetColumnData<T>
    : T extends SQL.Aliased<infer U>
      ? U
      : T extends SQL<infer U>
        ? U
        : never

export type SelectResultFields<TSelection> = {
  [Key in keyof TSelection]: SelectResultField<TSelection[Key]>
} & {}

/**
 * A select used as a table: `db.select().from(sq)`, with each selected field
 * readable as `sq.<key>` and qualified by the alias.
 */
export type SpannerSubquery<
  TSelection extends Record<string, unknown> = Record<string, unknown>,
  TAlias extends string = string
> = Subquery<TAlias, TSelection> & TSelection

type SelectionOf<
  TSelection extends SpannerSelectedFields | undefined,
  TTable
> = TSelection extends SpannerSelectedFields
  ? TSelection
  : TTable extends AnySpannerTable
    ? TTable['_']['columns']
    : TTable extends Subquery<string, infer S>
      ? S
      : never

type ResultOf<
  TSelection extends SpannerSelectedFields | undefined,
  TTable
> = TSelection extends SpannerSelectedFields
  ? SelectResultFields<TSelection>
  : TTable extends AnySpannerTable
    ? InferSelectModel<TTable>
    : TTable extends Subquery<string, infer S>
      ? SelectResultFields<S>
      : never

/** What a set operator takes on its right: a select (or compound) of the same row type. */
export interface SpannerSetOperand<TResult> {
  readonly _: { readonly result: Array<TResult> }
  getSQL(): SQL
}

/**
 * The select surface inside a transaction: everything `SpannerSelect` offers
 * except `withStaleness` and `withSignal` — a single-use bounded read cannot
 * run on an open transaction, and a callback the driver retries cannot be
 * cancelled one read at a time, so both are omitted from the type (spec:
 * runtime API).
 */
export interface SpannerTransactionSelect<TResult> extends PromiseLike<Array<TResult>> {
  where(where: SQL | undefined): this
  groupBy(...groupBy: Array<SpannerColumn<any> | SQL | SQL.Aliased>): this
  having(having: SQL | undefined): this
  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this
  limit(limit: number): this
  offset(offset: number): this
  withRequestOptions(options: SpannerRequestOptions): this
  toSQL(): Query
  execute(): Promise<Array<TResult>>
}

export interface SpannerTransactionSelectBuilder<
  TSelection extends SpannerSelectedFields | undefined
> {
  from<TTable extends AnySpannerTable | Subquery>(
    table: TTable
  ): SpannerTransactionSelect<ResultOf<TSelection, TTable>>
}

export class SpannerSelectBuilder<
  TSelection extends SpannerSelectedFields | undefined
> {
  static readonly [entityKind]: string = 'SpannerSelectBuilder'

  constructor(
    private readonly fields: TSelection,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect
  ) {}

  from<TTable extends AnySpannerTable | Subquery>(
    table: TTable
  ): SpannerSelect<ResultOf<TSelection, TTable>, SelectionOf<TSelection, TTable>> {
    const fields =
      this.fields ??
      (is(table, Subquery)
        ? // Read through the proxy, so each field is qualified by the subquery's alias.
          Object.fromEntries(
            Object.keys(table._.selectedFields).map((key) => [
              key,
              (table as unknown as Record<string, unknown>)[key]
            ])
          )
        : (table as AnySpannerTable)[TableColumns])
    return new SpannerSelect(table, fields, this.session, this.dialect)
  }
}

/** A read on the database: a select or a compound select, which combine by set operators and can be cancelled. */
abstract class SpannerReadQuery<TResult> extends SpannerQueryBase<Array<TResult>> {
  static override readonly [entityKind]: string = 'SpannerReadQuery'

  protected abstract setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult>

  /** `UNION ALL`: every row of both selects. */
  unionAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('union', true, right)
  }

  /** `UNION DISTINCT`: GoogleSQL has no bare `UNION`. */
  union(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('union', false, right)
  }

  intersect(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('intersect', false, right)
  }

  intersectAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('intersect', true, right)
  }

  except(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('except', false, right)
  }

  exceptAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('except', true, right)
  }

  /** Cancels the read when the signal aborts; the query rejects with the signal's reason. */
  withSignal(signal: AbortSignal): this {
    this.requestState = { ...this.requestState, signal }
    return this
  }
}

export class SpannerSelect<
  TResult,
  TSelection extends Record<string, unknown> = Record<string, unknown>
> extends SpannerReadQuery<TResult> {
  static override readonly [entityKind]: string = 'SpannerSelect'

  private readonly config: SpannerSelectConfig

  constructor(
    table: AnySpannerTable | Subquery,
    fields: Record<string, unknown>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect
  ) {
    super(session, dialect, 'select')
    this.config = { table, fields }
  }

  where(where: SQL | undefined): this {
    this.config.where = where
    return this
  }

  groupBy(...groupBy: Array<SpannerColumn<any> | SQL | SQL.Aliased>): this {
    this.config.groupBy = groupBy
    return this
  }

  having(having: SQL | undefined): this {
    this.config.having = having
    return this
  }

  /**
   * Turns the query into a single-use bounded read at the given staleness.
   * Only available on the database — inside any transaction it is omitted
   * from the select type and the session throws a typed error as backstop.
   */
  withStaleness(staleness: SpannerStaleness): this {
    this.requestState = {
      ...this.requestState,
      staleness: toTimestampBounds(staleness)
    }
    return this
  }

  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this {
    this.config.orderBy = orderBy
    return this
  }

  limit(limit: number): this {
    this.config.limit = limit
    return this
  }

  offset(offset: number): this {
    this.config.offset = offset
    return this
  }

  /** This select as a table named `alias`, for `db.select().from(...)`. */
  as<TAlias extends string>(alias: TAlias): SpannerSubquery<TSelection, TAlias> {
    return new Proxy(
      new Subquery(this.getSQL(), this.config.fields, alias),
      new SelectionProxyHandler({
        alias,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error'
      })
    ) as unknown as SpannerSubquery<TSelection, TAlias>
  }

  protected setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult> {
    return new SpannerSetOperation<TResult>(
      { left: this, operations: [{ operator, all, right }] },
      this.config.fields,
      this.session,
      this.dialect,
      this.requestState
    )
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSelectQuery(this.config)
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.config.fields)
  }
}

/**
 * Selects joined by set operators. `orderBy`, `limit` and `offset` apply to
 * the combined rows; a column in `orderBy` names the output column.
 */
export class SpannerSetOperation<TResult> extends SpannerReadQuery<TResult> {
  static override readonly [entityKind]: string = 'SpannerSetOperation'

  constructor(
    private readonly config: SpannerSetOperationConfig,
    private readonly fields: Record<string, unknown>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
    requestState: SpannerRequestState
  ) {
    super(session, dialect, 'select', requestState)
  }

  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this {
    this.config.orderBy = orderBy
    return this
  }

  limit(limit: number): this {
    this.config.limit = limit
    return this
  }

  offset(offset: number): this {
    this.config.offset = offset
    return this
  }

  protected setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult> {
    return new SpannerSetOperation<TResult>(
      {
        ...this.config,
        operations: [...this.config.operations, { operator, all, right }]
      },
      this.fields,
      this.session,
      this.dialect,
      this.requestState
    )
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSetOperationQuery(this.config)
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.fields)
  }
}
