import { entityKind } from 'drizzle-orm/entity';
import type { Param, SQL } from 'drizzle-orm/sql';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDialect, SpannerUpdateConfig } from '../dialect.js';
import type { SelectedFieldsOrdered } from '../internal.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
import { mapRowToParams, SpannerQueryBase } from './query-base.js';
import type { SelectResultFields, SpannerSelectedFields } from './select.js';

export type SpannerUpdateSet<TTable extends AnySpannerTable> = {
  [Key in keyof InferInsertModel<TTable>]?: InferInsertModel<TTable>[Key] | SQL | null;
};

export class SpannerUpdateBuilder<TTable extends AnySpannerTable> {
  static readonly [entityKind]: string = 'SpannerUpdateBuilder';

  constructor(
    private readonly table: TTable,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {}

  set(values: SpannerUpdateSet<TTable>): SpannerUpdate<TTable, void> {
    const mapped = mapRowToParams(this.table[TableColumns], values as Record<string, unknown>);
    return new SpannerUpdate(this.table, mapped, this.session, this.dialect);
  }
}

export class SpannerUpdate<TTable extends AnySpannerTable, TResult> extends SpannerQueryBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerUpdate';

  private readonly config: SpannerUpdateConfig;

  constructor(
    table: TTable,
    set: Record<string, Param | SQL>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
  ) {
    super(session, dialect, 'update');
    this.config = { table, set };
  }

  where(where: SQL | undefined): this {
    this.config.where = where;
    return this;
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerUpdate<TTable, InferSelectModel<TTable>[]>;
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerUpdate<TTable, SelectResultFields<TSelection>[]>;
  returning(
    fields: SpannerSelectedFields = this.config.table[TableColumns],
  ): SpannerUpdate<TTable, unknown> {
    this.config.returning = orderSelectedFields(fields);
    return this as SpannerUpdate<TTable, unknown>;
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildUpdateQuery(this.config);
  }

  protected selection(): SelectedFieldsOrdered | undefined {
    return this.config.returning;
  }
}
