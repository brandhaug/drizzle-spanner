import { entityKind } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import type {
  AnyRelations,
  BuildQueryResult,
  BuildRelationalQueryResult,
  DBQueryConfig,
  TableRelationalConfig,
  TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { mapRelationalRow } from 'drizzle-orm/relations';
import type { Query, SQL, SQLWrapper } from 'drizzle-orm/sql';
import type { KnownKeysOnly } from 'drizzle-orm/utils';
import type { SpannerDialect } from '../dialect.js';
import type { SpannerSession } from '../session.js';
import type { SpannerTable } from '../table.js';

/**
 * Unwraps the driver's number wrappers (`Int`, `Float`, `Float32`,
 * `Numeric`) so extras and other decoder-less selections yield plain values.
 * Column decoders unwrap on their own; a pre-unwrapped value passes through
 * them unchanged. Plain objects (JSON columns, structs) are left alone.
 */
function unwrapWrappedNumber(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'value' in value) {
    const name = (value as object).constructor?.name;
    if (name === 'Int' || name === 'Float' || name === 'Float32' || name === 'Numeric') {
      return (value as { value: unknown }).value;
    }
  }
  return value;
}

export class SpannerRelationalQueryBuilder<
  TSchema extends TablesRelationalConfig,
  TFields extends TableRelationalConfig,
> {
  static readonly [entityKind]: string = 'SpannerRelationalQueryBuilder';

  constructor(
    private readonly schema: AnyRelations,
    private readonly table: SpannerTable,
    private readonly tableConfig: TableRelationalConfig,
    private readonly dialect: SpannerDialect,
    private readonly session: SpannerSession,
  ) {}

  findMany<TConfig extends DBQueryConfig<'many', TSchema, TFields>>(
    config?: KnownKeysOnly<TConfig, DBQueryConfig<'many', TSchema, TFields>>,
  ): SpannerRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[]> {
    return new SpannerRelationalQuery(
      this.schema,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      config ?? true,
      'many',
    );
  }

  findFirst<TConfig extends DBQueryConfig<'one', TSchema, TFields>>(
    config?: KnownKeysOnly<TConfig, DBQueryConfig<'one', TSchema, TFields>>,
  ): SpannerRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig> | undefined> {
    return new SpannerRelationalQuery(
      this.schema,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      config ?? true,
      'first',
    );
  }
}

export class SpannerRelationalQuery<TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerRelationalQuery';

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult };

  constructor(
    private readonly schema: AnyRelations,
    private readonly table: SpannerTable,
    private readonly tableConfig: TableRelationalConfig,
    private readonly dialect: SpannerDialect,
    private readonly session: SpannerSession,
    private readonly config: unknown,
    private readonly mode: 'many' | 'first',
  ) {
    super();
  }

  private buildQuery(): BuildRelationalQueryResult {
    return this.dialect.buildRelationalQuery({
      schema: this.schema,
      table: this.table,
      tableConfig: this.tableConfig,
      queryConfig: this.config as never,
      mode: this.mode,
    });
  }

  /** @internal */
  getSQL(): SQL {
    return this.buildQuery().sql;
  }

  toSQL(): Query {
    const { sql, params } = this.dialect.sqlToQuery(this.getSQL());
    return { sql, params };
  }

  override execute(): Promise<TResult> {
    const query = this.buildQuery();
    return this.session
      .prepareRelationalQuery<TResult>(this.dialect.sqlToQuery(query.sql), (rows) => {
        const mapped = rows.map(
          (row) => mapRelationalRow(row, query.selection, unwrapWrappedNumber) as never,
        );
        return (this.mode === 'first' ? mapped[0] : mapped) as TResult;
      })
      .execute();
  }
}
