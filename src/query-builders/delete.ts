import { entityKind } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import type { Query, SQL, SQLWrapper } from 'drizzle-orm/sql';
import type { InferSelectModel } from 'drizzle-orm/table';
import type { SpannerDeleteConfig, SpannerDialect } from '../dialect.js';
import { orderSelectedFields } from '../internal.js';
import type { SpannerPreparedQuery, SpannerSession } from '../session.js';
import type { AnySpannerTable } from '../table.js';
import { TableColumns } from '../symbols.js';
import type { SelectResultFields, SpannerSelectedFields } from './select.js';

export class SpannerDelete<TTable extends AnySpannerTable, TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerDelete';

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult };

  private readonly config: SpannerDeleteConfig;

  constructor(
    table: TTable,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect,
  ) {
    super();
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
      { type: 'delete' },
    );
  }

  override execute(): Promise<TResult> {
    return this._prepare().execute();
  }
}
