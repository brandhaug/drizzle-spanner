import { entityKind, is } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import type { Query, SQLWrapper } from 'drizzle-orm/sql';
import { Param, SQL } from 'drizzle-orm/sql';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDialect, SpannerInsertConfig } from '../dialect.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerPreparedQuery, SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
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
    const mappedRows = rows.map((row) => {
      const mapped: Record<string, Param | SQL> = {};
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        if (value === undefined) continue;
        mapped[key] = is(value, SQL) ? value : new Param(value, columns[key]);
      }
      return mapped;
    });
    return new SpannerInsert(this.table, mappedRows, this.session, this.dialect);
  }
}

export class SpannerInsert<TTable extends AnySpannerTable, TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerInsert';

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult };

  private readonly config: SpannerInsertConfig;

  constructor(
    table: TTable,
    values: Record<string, Param | SQL>[],
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {
    super();
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

  toSQL(): Query {
    const { sql, params } = this.dialect.sqlToQuery(this.getSQL());
    return { sql, params };
  }

  /** @internal */
  _prepare(): SpannerPreparedQuery<TResult> {
    if (!this.session) {
      throw new Error('Cannot execute a query on a mock database: no client is attached');
    }
    return this.session.prepareQuery<TResult>(
      this.dialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? undefined : () => undefined as TResult,
      { type: 'insert' },
    );
  }

  override execute(): Promise<TResult> {
    return this._prepare().execute();
  }
}
