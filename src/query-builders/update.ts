import { entityKind } from 'drizzle-orm/entity'
import { type Param, type SQL } from 'drizzle-orm/sql'
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm/table'
import { type SpannerDialect, type SpannerUpdateConfig } from '../dialect.js'
import { SpannerInvalidArgumentError } from '../errors.js'
import { type SpannerMutationSink } from '../mutations.js'
import { toMutationRow, whereToPrimaryKey } from '../mutations.js'
import { type SpannerSession } from '../session.js'
import { type AnySpannerTable } from '../table.js'
import { TableColumns, TableName } from '../symbols.js'
import { mapRowToParams, SpannerFilteredDmlBase } from './query-base.js'
import { type SelectResultFields, type SpannerSelectedFields } from './select.js'

export type SpannerUpdateSet<TTable extends AnySpannerTable> = {
  [Key in keyof InferInsertModel<TTable>]?: InferInsertModel<TTable>[Key] | SQL | null
}

export class SpannerUpdateBuilder<TTable extends AnySpannerTable> {
  static readonly [entityKind]: string = 'SpannerUpdateBuilder'

  constructor(
    private readonly table: TTable,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect
  ) {}

  set(values: SpannerUpdateSet<TTable>): SpannerUpdate<TTable, void> {
    const mapped = mapRowToParams(
      this.table[TableColumns],
      values as Record<string, unknown>
    )
    return new SpannerUpdate(this.table, mapped, this.session, this.dialect)
  }
}

export class SpannerUpdate<
  TTable extends AnySpannerTable,
  TResult
> extends SpannerFilteredDmlBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerUpdate'

  protected readonly config: SpannerUpdateConfig

  constructor(
    table: TTable,
    set: Record<string, Param | SQL>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect
  ) {
    super(session, dialect, 'update')
    this.config = { table, set }
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerUpdate<TTable, Array<InferSelectModel<TTable>>>
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection
  ): SpannerUpdate<TTable, Array<SelectResultFields<TSelection>>>
  returning(fields?: SpannerSelectedFields): SpannerUpdate<TTable, unknown> {
    return this.setReturning(fields) as SpannerUpdate<TTable, unknown>
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildUpdateQuery(this.config)
  }

  protected override writeMutation(sink: SpannerMutationSink): void {
    this.assertNoReturningInMutation()
    const { table, set, where } = this.config
    const key = whereToPrimaryKey(table, where, 'update')
    // An update mutation row is the full key plus the changed columns.
    const row = toMutationRow(this.dialect, table, set)
    for (const [i, column] of key.columns.entries()) {
      const cased = column.name
      if (cased in row) {
        throw new SpannerInvalidArgumentError({
          message: `Cannot set primary-key column "${column.name}" in a bufferedMutations update: mutations address rows by key`
        })
      }
      row[cased] = key.values[i]
    }
    sink.update(table[TableName], [row])
  }
}
