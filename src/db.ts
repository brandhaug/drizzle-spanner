import { entityKind } from 'drizzle-orm/entity';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { SQL } from 'drizzle-orm/sql';
import type { SpannerDialect } from './dialect.js';
import { GrpcStatus, SpannerAbortedError, wrapSpannerError } from './errors.js';
import type { SpannerDriverRow, SpannerSqlRequest } from './session.js';
import { NO_CLIENT_MESSAGE, SpannerSession } from './session.js';
import { unwrapDriverWrapper } from './columns/common.js';
import { SpannerDelete } from './query-builders/delete.js';
import { SpannerInsertBuilder } from './query-builders/insert.js';
import type { SpannerSelectedFields } from './query-builders/select.js';
import { SpannerSelectBuilder } from './query-builders/select.js';
import { SpannerUpdateBuilder } from './query-builders/update.js';
import type { AnySpannerTable } from './table.js';

/**
 * Structural view of the `@google-cloud/spanner` surfaces this adapter uses.
 * `drizzle()` takes the real `Database`; these types keep the runtime free of
 * a hard import so unit tests and `drizzle.mock()` need no driver install.
 */
export interface SpannerDriverTransaction {
  run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[], ...unknown[]]>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

export interface SpannerDriverDatabase {
  run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[], ...unknown[]]>;
  runTransactionAsync<T>(runFn: (transaction: SpannerDriverTransaction) => Promise<T>): Promise<T>;
}

function isAborted(error: unknown): boolean {
  return (error as { code?: unknown })?.code === GrpcStatus.ABORTED;
}

/** Reads on `database.run`; each standalone DML statement in its own read-write transaction. */
class DatabaseRunner {
  constructor(private readonly database: SpannerDriverDatabase) {}

  async run(request: SpannerSqlRequest, isDml: boolean): Promise<SpannerDriverRow[]> {
    if (!isDml) {
      const [rows] = await this.database.run(request);
      return rows;
    }
    // database.run is read-only; DML (with THEN RETURN) must go through a
    // read-write transaction, and txn.run (not runUpdate) yields the rows.
    return this.database.runTransactionAsync(async (transaction) => {
      const [rows] = await transaction.run(request);
      await transaction.commit();
      return rows;
    });
  }
}

/** Everything inside `db.transaction` runs on the one open driver transaction. */
class TransactionRunner {
  constructor(private readonly transaction: SpannerDriverTransaction) {}

  async run(request: SpannerSqlRequest): Promise<SpannerDriverRow[]> {
    const [rows] = await this.transaction.run(request);
    return rows;
  }
}

class MockRunner {
  run(): Promise<SpannerDriverRow[]> {
    throw new Error(NO_CLIENT_MESSAGE);
  }
}

/**
 * `DrizzleConfig` keys the adapter accepts but does not consume yet:
 * `relations` feeds the milestone-2 relational query builder and `cache` the
 * milestone-2 cache integration. They are carried so user config is stable
 * across milestones.
 */
export interface SpannerDatabaseOptions {
  relations?: unknown;
  cache?: unknown;
}

export class SpannerDatabase {
  static readonly [entityKind]: string = 'SpannerDatabase';

  constructor(
    /** @internal */
    readonly dialect: SpannerDialect,
    /** @internal */
    readonly session: SpannerSession,
    readonly $client: SpannerDriverDatabase | undefined,
    /** @internal */
    readonly options: SpannerDatabaseOptions = {},
  ) {}

  select(): SpannerSelectBuilder<undefined>;
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerSelectBuilder<TSelection>;
  select(fields?: SpannerSelectedFields): SpannerSelectBuilder<SpannerSelectedFields | undefined> {
    return new SpannerSelectBuilder(fields, this.session, this.dialect);
  }

  insert<TTable extends AnySpannerTable>(table: TTable): SpannerInsertBuilder<TTable> {
    return new SpannerInsertBuilder(table, this.session, this.dialect);
  }

  update<TTable extends AnySpannerTable>(table: TTable): SpannerUpdateBuilder<TTable> {
    return new SpannerUpdateBuilder(table, this.session, this.dialect);
  }

  delete<TTable extends AnySpannerTable>(table: TTable): SpannerDelete<TTable, void> {
    return new SpannerDelete(table, this.session, this.dialect);
  }

  /** `select count(*) from table [where ...]` returning a number. */
  async $count(table: AnySpannerTable | SQL, where?: SQL): Promise<number> {
    const query = this.dialect.sqlToQuery(this.dialect.buildCountQuery(table as never, where));
    const prepared = this.session.prepareQuery<number>(query, undefined, (rows) =>
      Number(unwrapDriverWrapper(rows[0]?.[0])),
    );
    return prepared.execute();
  }

  /** Raw SQL escape hatch; rows arrive as the driver's `toJSON()` objects. */
  execute<T = Record<string, unknown>[]>(query: SQL): Promise<T> {
    return this.session.execute<T>(query);
  }

  /**
   * Read-write transaction over `runTransactionAsync`. The callback
   * re-executes automatically on ABORTED — it must be free of external side
   * effects. `SpannerAbortedError` surfaces only when retries are exhausted.
   */
  async transaction<T>(callback: (tx: SpannerTransaction) => Promise<T>): Promise<T> {
    const client = this.$client;
    if (!client) {
      throw new Error('Cannot start a transaction on a mock database: no client is attached');
    }
    try {
      return await client.runTransactionAsync(async (driverTransaction) => {
        const transactionSession = new SpannerSession(
          new TransactionRunner(driverTransaction),
          this.dialect,
          this.session.options,
        );
        const tx = new SpannerTransaction(this.dialect, transactionSession, this.$client, this.options);
        try {
          const result = await callback(tx);
          await driverTransaction.commit();
          return result;
        } catch (error) {
          // ABORTED must propagate untouched so the driver's transaction
          // runner retries the whole callback.
          if (isAborted(error)) throw error;
          try {
            await driverTransaction.rollback();
          } catch {
            // The rollback is best-effort; the original error matters more.
          }
          throw error;
        }
      });
    } catch (error) {
      // The driver's DeadlineError means ABORTED retries ran out of time.
      if ((error as { name?: string })?.name === 'DeadlineError') {
        throw new SpannerAbortedError({
          message: 'Read-write transaction aborted and retries were exhausted',
          code: GrpcStatus.ABORTED,
          cause: error,
        });
      }
      throw wrapSpannerError(error);
    }
  }
}

export class SpannerTransaction extends SpannerDatabase {
  static override readonly [entityKind]: string = 'SpannerTransaction';

  override transaction<T>(_callback: (tx: SpannerTransaction) => Promise<T>): Promise<T> {
    throw new Error('Spanner does not support nested transactions (no savepoints)');
  }

  /** Aborts the transaction by throwing `TransactionRollbackError`. */
  rollback(): never {
    throw new TransactionRollbackError();
  }
}

export function createDatabaseSession(
  database: SpannerDriverDatabase,
  dialect: SpannerDialect,
  options?: { logger?: SpannerSession['logger'] },
): SpannerSession {
  return new SpannerSession(new DatabaseRunner(database), dialect, options);
}

export function createMockSession(dialect: SpannerDialect): SpannerSession {
  return new SpannerSession(new MockRunner(), dialect, {});
}
