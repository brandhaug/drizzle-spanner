import { entityKind } from 'drizzle-orm/entity';
import type { SQL } from 'drizzle-orm/sql';
import type { InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDeleteConfig, SpannerDialect } from '../dialect.js';
import type { SelectedFieldsOrdered } from '../internal.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
import { SpannerQueryBase } from './query-base.js';
import type { SelectResultFields, SpannerSelectedFields } from './select.js';

export class SpannerDelete<TTable extends AnySpannerTable, TResult> extends SpannerQueryBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerDelete';

  private readonly config: SpannerDeleteConfig;

  constructor(
    table: TTable,
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
  ) {
    super(session, dialect, 'delete');
    this.config = { table };
  }

  where(where: SQL | undefined): this {
    this.config.where = where;
    return this;
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerDelete<TTable, InferSelectModel<TTable>[]>;
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerDelete<TTable, SelectResultFields<TSelection>[]>;
  returning(
    fields: SpannerSelectedFields = this.config.table[TableColumns],
  ): SpannerDelete<TTable, unknown> {
    this.config.returning = orderSelectedFields(fields);
    return this as SpannerDelete<TTable, unknown>;
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildDeleteQuery(this.config);
  }

  protected selection(): SelectedFieldsOrdered | undefined {
    return this.config.returning;
  }
}
