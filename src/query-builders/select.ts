import { entityKind } from 'drizzle-orm/entity'
import { type Query, type SQL } from 'drizzle-orm/sql'
import { type Column, type GetColumnData } from 'drizzle-orm/column'
import { type InferSelectModel } from 'drizzle-orm/table'
import { type SpannerColumn } from '../columns/common.js'
import { type SpannerDialect, type SpannerSelectConfig } from '../dialect.js'
import { type SelectedFieldsOrdered } from '../orm-internal.js'
import { orderSelectedFields } from '../orm-internal.js'
import { type SpannerSession } from '../session.js'
import { type SpannerStaleness } from '../staleness.js'
import { toTimestampBounds } from '../staleness.js'
import { type AnySpannerTable } from '../table.js'
import { TableColumns } from '../symbols.js'
import { SpannerQueryBase } from './query-base.js'

export type SpannerSelectedFields = Record<
  string,
  SpannerColumn<any> | SQL | SQL.Aliased
>

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
 * The select surface inside a transaction: everything `SpannerSelect` offers
 * except `withStaleness` — a single-use bounded read cannot run on an open
 * transaction, so the method is omitted from the type (spec: runtime API).
 */
export interface SpannerTransactionSelect<TResult> extends PromiseLike<Array<TResult>> {
  where(where: SQL | undefined): this
  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this
  limit(limit: number): this
  offset(offset: number): this
  toSQL(): Query
  execute(): Promise<Array<TResult>>
}

export interface SpannerTransactionSelectBuilder<
  TSelection extends SpannerSelectedFields | undefined
> {
  from<TTable extends AnySpannerTable>(
    table: TTable
  ): SpannerTransactionSelect<
    TSelection extends SpannerSelectedFields
      ? SelectResultFields<TSelection>
      : InferSelectModel<TTable>
  >
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

  from<TTable extends AnySpannerTable>(
    table: TTable
  ): SpannerSelect<
    TSelection extends SpannerSelectedFields
      ? SelectResultFields<TSelection>
      : InferSelectModel<TTable>
  > {
    const fields = this.fields ?? table[TableColumns]
    return new SpannerSelect(table, fields, this.session, this.dialect)
  }
}

export class SpannerSelect<TResult> extends SpannerQueryBase<Array<TResult>> {
  static override readonly [entityKind]: string = 'SpannerSelect'

  private readonly config: SpannerSelectConfig

  constructor(
    table: AnySpannerTable,
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

  /**
   * Turns the query into a single-use bounded read at the given staleness.
   * Only available on the database — inside any transaction it is omitted
   * from the select type and the session throws a typed error as backstop.
   */
  withStaleness(staleness: SpannerStaleness): this {
    this.stalenessBounds = toTimestampBounds(staleness)
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

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSelectQuery(this.config)
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.config.fields)
  }
}
