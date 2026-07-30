import { entityKind } from 'drizzle-orm/entity';
import type { Param, SQL } from 'drizzle-orm/sql';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDialect, SpannerInsertConfig } from '../dialect.js';
import { SpannerInvalidArgumentError } from '../errors.js';
import type { SpannerMutationSink } from '../mutations.js';
import { toMutationRow } from '../mutations.js';
import type { SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns, TableName } from '../symbols.js';
import { mapRowToParams, SpannerDmlBase } from './query-base.js';
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

export class SpannerInsert<TTable extends AnySpannerTable, TResult> extends SpannerDmlBase<TResult> {
  static override readonly [entityKind]: string = 'SpannerInsert';

  protected readonly config: SpannerInsertConfig;

  constructor(
    table: TTable,
    values: Record<string, Param | SQL>[],
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
  ) {
    super(session, dialect, 'insert');
    this.config = { table, values };
  }

  private setConflictAction(action: 'update' | 'ignore'): this {
    if (this.config.conflictAction && this.config.conflictAction !== action) {
      throw new SpannerInvalidArgumentError({
        message:
          'orUpdate() and orIgnore() are mutually exclusive: one INSERT carries one conflict action',
      });
    }
    this.config.conflictAction = action;
    return this;
  }

  /**
   * `INSERT OR UPDATE` — upsert: a conflicting row is replaced with the full
   * column list of this statement (no partial `ON CONFLICT`-style updates;
   * omitted columns reset to their defaults). ADR 0002.
   */
  orUpdate(): this {
    return this.setConflictAction('update');
  }

  /** `INSERT OR IGNORE` — a conflicting row is left unchanged. ADR 0002. */
  orIgnore(): this {
    return this.setConflictAction('ignore');
  }

  /** Compiles to `THEN RETURN` — Spanner's RETURNING. */
  returning(): SpannerInsert<TTable, InferSelectModel<TTable>[]>;
  returning<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerInsert<TTable, SelectResultFields<TSelection>[]>;
  returning(fields?: SpannerSelectedFields): SpannerInsert<TTable, unknown> {
    return this.setReturning(fields) as SpannerInsert<TTable, unknown>;
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildInsertQuery(this.config);
  }

  protected override writeMutation(sink: SpannerMutationSink): void {
    this.assertNoReturningInMutation();
    const { table, values, conflictAction } = this.config;
    if (conflictAction === 'ignore') {
      // Spanner mutations have insert/update/insertOrUpdate/replace/delete —
      // no insert-or-ignore form (ADR 0002 consequences).
      throw new SpannerInvalidArgumentError({
        message:
          'orIgnore() has no mutation form in a bufferedMutations transaction; use a read-write transaction for INSERT OR IGNORE',
      });
    }
    const rows = values.map((row) => toMutationRow(this.dialect, table, row));
    if (conflictAction === 'update') {
      sink.upsert(table[TableName], rows);
    } else {
      sink.insert(table[TableName], rows);
    }
  }
}
