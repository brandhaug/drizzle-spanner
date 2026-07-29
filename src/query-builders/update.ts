import { entityKind, is } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import type { Query, SQLWrapper } from 'drizzle-orm/sql';
import { Param, SQL } from 'drizzle-orm/sql';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDialect, SpannerUpdateConfig } from '../dialect.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerPreparedQuery, SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
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
    const columns = this.table[TableColumns];
    const mapped: Record<string, Param | SQL> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (value === undefined) continue;
      mapped[key] = is(value, SQL) ? value : new Param(value, columns[key]);
    }
    return new SpannerUpdate(this.table, mapped, this.session, this.dialect);
  }
}

export class SpannerUpdate<TTable extends AnySpannerTable, TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerUpdate';

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult };

  private readonly config: SpannerUpdateConfig;

  constructor(
    table: TTable,
    set: Record<string, Param | SQL>,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {
    super();
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
      { type: 'update' },
    );
  }

  override execute(): Promise<TResult> {
    return this._prepare().execute();
  }
}
