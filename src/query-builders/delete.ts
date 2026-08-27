import { entityKind } from 'drizzle-orm/entity'
import { type SQL } from 'drizzle-orm/sql'
import { type InferSelectModel } from 'drizzle-orm/table'
import { type SpannerDeleteConfig, type SpannerDialect } from '../dialect.js'
import { type SpannerMutationSink } from '../mutations.js'
import { whereToPrimaryKey } from '../mutations.js'
import { type SpannerSession } from '../session.js'
import { type AnySpannerTable } from '../table.js'
import { TableName } from '../symbols.js'
import { SpannerFilteredDmlBase } from './query-base.js'
import { type SelectResultFields, type SpannerSelectedFields } from './select.js'

export class SpannerDelete<
  TTable extends AnySpannerTable,
  TResult
> extends SpannerFilteredDmlBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerDelete'

  protected readonly config: SpannerDeleteConfig

  constructor(
    table: TTable,
    session: SpannerSession | undefined,
    dialect: SpannerDialect
  ) {
    super(session, dialect, 'delete')
    this.config = { table }
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerDelete<TTable, InferSelectModel<TTable>[]>
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection
  ): SpannerDelete<TTable, SelectResultFields<TSelection>[]>
  returning(fields?: SpannerSelectedFields): SpannerDelete<TTable, unknown> {
    return this.setReturning(fields) as SpannerDelete<TTable, unknown>
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildDeleteQuery(this.config)
  }

  protected override writeMutation(sink: SpannerMutationSink): void {
    this.assertNoReturningInMutation()
    const { table, where } = this.config
    const key = whereToPrimaryKey(table, where, 'delete')
    sink.deleteRows(table[TableName], [key.values])
  }
}
