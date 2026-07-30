import { entityKind } from 'drizzle-orm/entity';
import type { SQL } from 'drizzle-orm/sql';
import type { Column, GetColumnData } from 'drizzle-orm/column';
import type { InferSelectModel } from 'drizzle-orm/table';
import type { SpannerColumn } from '../columns/common.js';
import type { SpannerDialect, SpannerSelectConfig } from '../dialect.js';
import type { SelectedFieldsOrdered } from '../internal.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
import { SpannerQueryBase } from './query-base.js';

export type SpannerSelectedFields = Record<string, SpannerColumn<any> | SQL | SQL.Aliased>;

export type SelectResultField<T> = T extends Column<any>
  ? GetColumnData<T>
  : T extends SQL.Aliased<infer U>
    ? U
    : T extends SQL<infer U>
      ? U
      : never;

export type SelectResultFields<TSelection> = {
  [Key in keyof TSelection]: SelectResultField<TSelection[Key]>;
} & {};

export class SpannerSelectBuilder<TSelection extends SpannerSelectedFields | undefined> {
  static readonly [entityKind]: string = 'SpannerSelectBuilder';

  constructor(
    private readonly fields: TSelection,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {}

  from<TTable extends AnySpannerTable>(
    table: TTable,
  ): SpannerSelect<
    TSelection extends SpannerSelectedFields
      ? SelectResultFields<TSelection>
      : InferSelectModel<TTable>
  > {
    const fields = this.fields ?? table[TableColumns];
    return new SpannerSelect(table, fields, this.session, this.dialect);
  }
}

export class SpannerSelect<TResult> extends SpannerQueryBase<TResult[]> {
  static override readonly [entityKind]: string = 'SpannerSelect';

  private readonly config: SpannerSelectConfig;

  constructor(
    table: AnySpannerTable,
    fields: Record<string, unknown>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
  ) {
    super(session, dialect, 'select');
    this.config = { table, fields };
  }

  where(where: SQL | undefined): this {
    this.config.where = where;
    return this;
  }

  orderBy(...orderBy: (SpannerColumn<any> | SQL)[]): this {
    this.config.orderBy = orderBy;
    return this;
  }

  limit(limit: number): this {
    this.config.limit = limit;
    return this;
  }

  offset(offset: number): this {
    this.config.offset = offset;
    return this;
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSelectQuery(this.config);
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.config.fields);
  }
}
