import { entityKind } from 'drizzle-orm/entity';
import type { Param, SQL } from 'drizzle-orm/sql';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDialect, SpannerInsertConfig } from '../dialect.js';
import { SpannerInvalidArgumentError } from '../errors.js';
import type { SpannerMutationSink } from '../mutations.js';
import { toMutationRow } from '../mutations.js';
import type { SelectedFieldsOrdered } from '../internal.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns, TableName } from '../symbols.js';
import { mapRowToParams, SpannerQueryBase } from './query-base.js';
import type { SelectResultFields, SpannerSelectedFields } from './select.js';

export type SpannerInsertValue<TTable extends AnySpannerTable> = {
  [Key in keyof InferInsertModel<TTable>]: InferInsertModel<TTable>[Key] | SQL;
};

export class SpannerInsertBuilder<TTable extends AnySpannerTable> {
  static readonly [entityKind]: string = 'SpannerInsertBuilder';

  constructor(
    private readonly table: TTable,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {}

  values(value: SpannerInsertValue<TTable>): SpannerInsert<TTable, void>;
  values(values: SpannerInsertValue<TTable>[]): SpannerInsert<TTable, void>;
  values(
    values: SpannerInsertValue<TTable> | SpannerInsertValue<TTable>[],
  ): SpannerInsert<TTable, void> {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0) {
      throw new Error('values() must be called with at least one value');
    }
    const columns = this.table[TableColumns];
    const mappedRows = rows.map((row) =>
      mapRowToParams(columns, row as Record<string, unknown>),
    );
    return new SpannerInsert(this.table, mappedRows, this.session, this.dialect);
  }
}

export class SpannerInsert<TTable extends AnySpannerTable, TResult> extends SpannerQueryBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerInsert';

  private readonly config: SpannerInsertConfig;

  constructor(
    table: TTable,
    values: Record<string, Param | SQL>[],
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
  ) {
    super(session, dialect, 'insert');
    this.config = { table, values };
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerInsert<TTable, InferSelectModel<TTable>[]>;
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerInsert<TTable, SelectResultFields<TSelection>[]>;
  returning(
    fields: SpannerSelectedFields = this.config.table[TableColumns],
  ): SpannerInsert<TTable, unknown> {
    this.config.returning = orderSelectedFields(fields);
    return this as SpannerInsert<TTable, unknown>;
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildInsertQuery(this.config);
  }

  protected selection(): SelectedFieldsOrdered | undefined {
    return this.config.returning;
  }

  protected override writeMutation(sink: SpannerMutationSink): void {
    if (this.config.returning) {
      throw new SpannerInvalidArgumentError({
        message:
          'returning() is not available inside a bufferedMutations transaction: mutations return nothing; use a read-write transaction',
      });
    }
    const { table, values } = this.config;
    sink.insert(
      table[TableName],
      values.map((row) => toMutationRow(this.dialect, table, row)),
    );
  }
}
