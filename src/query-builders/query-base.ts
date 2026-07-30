import { entityKind, is } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import type { Query, SQLWrapper } from 'drizzle-orm/sql';
import { Param, SQL } from 'drizzle-orm/sql';
import type { SpannerDialect } from '../dialect.js';
import type { SelectedFieldsOrdered } from '../internal.js';
import type { SpannerPreparedQuery, SpannerQueryMetadata, SpannerSession } from '../session.js';
import { NO_CLIENT_MESSAGE } from '../session.js';
import type { SpannerTimestampBounds } from '../staleness.js';
import type { SpannerColumns } from '../table.js';

/** Wraps plain values in `Param` bound to their table column; SQL passes through. */
export function mapRowToParams(
  columns: SpannerColumns,
  row: Record<string, unknown>,
): Record<string, Param | SQL> {
  const mapped: Record<string, Param | SQL> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    mapped[key] = is(value, SQL) ? value : new Param(value, columns[key]);
  }
  return mapped;
}

/**
 * Shared executable-query shape of the four builders: compile via `getSQL()`,
 * prepare against the session (or throw the mock guard), execute.
 */
export abstract class SpannerQueryBase<TResult>
  extends QueryPromise<TResult>
  implements SQLWrapper
{
  static override readonly [entityKind]: string = 'SpannerQueryBase';

  declare readonly _: { readonly dialect: 'spanner'; readonly result: TResult };

  /** Set by `SpannerSelect.withStaleness`; undefined for every other builder. */
  protected stalenessBounds: SpannerTimestampBounds | undefined;

  constructor(
    private readonly session: SpannerSession | undefined,
    protected readonly dialect: SpannerDialect,
    private readonly queryType: SpannerQueryMetadata['type'],
  ) {
    super();
  }

  /** @internal */
  abstract getSQL(): SQL;

  /** The selection rows map through; undefined for DML without `.returning()`. */
  protected abstract selection(): SelectedFieldsOrdered | undefined;

  toSQL(): Query {
    const { sql, params } = this.dialect.sqlToQuery(this.getSQL());
    return { sql, params };
  }

  /** @internal */
  _prepare(): SpannerPreparedQuery<TResult> {
    if (!this.session) {
      throw new Error(NO_CLIENT_MESSAGE);
    }
    const fields = this.selection();
    return this.session.prepareQuery<TResult>(
      this.dialect.sqlToQuery(this.getSQL()),
      fields,
      fields ? undefined : () => undefined as TResult,
      { type: this.queryType, staleness: this.stalenessBounds },
    );
  }

  override execute(): Promise<TResult> {
    return this._prepare().execute();
  }
}
