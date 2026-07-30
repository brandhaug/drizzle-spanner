import { Column } from 'drizzle-orm/column';
import { entityKind, is } from 'drizzle-orm/entity';
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
 * The driver's number wrappers (`Int`, `Float`, `Float32`, `Numeric`).
 * Column decoders unwrap these on their own; extras have no decoder, so
 * their wrappers convert here via `valueOf` (which throws past 2^53−1 —
 * use `.mapWith()` on the extra for the full INT64 range).
 */
function isWrappedNumber(value: unknown): value is { valueOf(): number } {
  if (value === null || typeof value !== 'object' || !('value' in value)) return false;
  const name = (value as object).constructor?.name;
  return name === 'Int' || name === 'Float' || name === 'Float32' || name === 'Numeric';
}

/**
 * Normalizes a raw driver row in place ahead of `mapRelationalRow`:
 * - to-one relations arrive as one-element arrays (Spanner cannot return a
 *   bare STRUCT column, so they compile to `ARRAY(... LIMIT 1)`) and unwrap
 *   to the element or null;
 * - extras values shed the driver's number wrappers.
 */
function normalizeRelationalRow(
  row: Record<string, unknown>,
  selection: BuildRelationalQueryResult['selection'],
): void {
  for (const item of selection) {
    const value = row[item.key];
    if (item.selection) {
      if (item.isArray) {
        if (Array.isArray(value)) {
          for (const element of value) {
            normalizeRelationalRow(element as Record<string, unknown>, item.selection);
          }
        }
        continue;
      }
      const single = Array.isArray(value) ? ((value[0] as Record<string, unknown>) ?? null) : null;
      row[item.key] = single;
      if (single) normalizeRelationalRow(single, item.selection);
      continue;
    }
    // Columns keep their wrappers — their decoders unwrap with full range
    // (int64 bigint mode included). Only decoder-less extras convert here.
    if (!is(item.field, Column) && isWrappedNumber(value)) {
      row[item.key] = value.valueOf();
    }
  }
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
        const mapped = rows.map((row) => {
          normalizeRelationalRow(row, query.selection);
          return mapRelationalRow(row, query.selection) as never;
        });
        return (this.mode === 'first' ? mapped[0] : mapped) as TResult;
      })
      .execute();
  }
}
