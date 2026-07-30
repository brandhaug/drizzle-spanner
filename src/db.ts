import { entityKind } from 'drizzle-orm/entity';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { AnyRelations, EmptyRelations } from 'drizzle-orm/relations';
import type { SQL } from 'drizzle-orm/sql';
import type { SpannerDialect } from './dialect.js';
import {
  GrpcStatus,
  SpannerAbortedError,
  SpannerInvalidArgumentError,
  wrapSpannerError,
} from './errors.js';
import type { SpannerStaleness, SpannerTimestampBounds } from './staleness.js';
import { toTimestampBounds } from './staleness.js';
import type { SpannerDriverRow, SpannerSqlRequest } from './session.js';
import { NO_CLIENT_MESSAGE, SpannerSession } from './session.js';
import { unwrapDriverWrapper } from './columns/common.js';
import { SpannerDelete } from './query-builders/delete.js';
import { SpannerInsertBuilder } from './query-builders/insert.js';
import { SpannerRelationalQueryBuilder } from './query-builders/query.js';
import type {
  SpannerSelectedFields,
  SpannerTransactionSelectBuilder,
} from './query-builders/select.js';
import { SpannerSelectBuilder } from './query-builders/select.js';
import { SpannerUpdateBuilder } from './query-builders/update.js';
import type { AnySpannerTable, SpannerTable } from './table.js';

/**
 * Structural view of the `@google-cloud/spanner` surfaces this adapter uses.
 * `drizzle()` takes the real `Database`; these types keep the runtime free of
 * a hard import so unit tests and `drizzle.mock()` need no driver install.
 */
export interface SpannerDriverTransaction {
  run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[], ...unknown[]]>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  /** Mutation buffer used by the bufferedMutations transaction mode. */
  insert(table: string, rows: Record<string, unknown>[]): void;
  update(table: string, rows: Record<string, unknown>[]): void;
  deleteRows(table: string, keys: unknown[][]): void;
}

/** Options the driver's transaction runner accepts (`RunTransactionOptions`). */
export interface SpannerDriverRunTransactionOptions {
  timeout?: number;
}

/** A read-only snapshot from `database.getSnapshot`. */
export interface SpannerDriverSnapshot {
  run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[], ...unknown[]]>;
  end(): void;
}

export interface SpannerDriverDatabase {
  run(
    request: SpannerSqlRequest,
    bounds?: SpannerTimestampBounds,
  ): Promise<[SpannerDriverRow[], ...unknown[]]>;
  runTransactionAsync<T>(runFn: (transaction: SpannerDriverTransaction) => Promise<T>): Promise<T>;
  runTransactionAsync<T>(
    options: SpannerDriverRunTransactionOptions,
    runFn: (transaction: SpannerDriverTransaction) => Promise<T>,
  ): Promise<T>;
  getSnapshot(
    bounds?: SpannerTimestampBounds,
  ): Promise<readonly [SpannerDriverSnapshot, ...unknown[]]>;
}

function isAborted(error: unknown): boolean {
  return (error as { code?: unknown })?.code === GrpcStatus.ABORTED;
}

/** Reads on `database.run`; each standalone DML statement in its own read-write transaction. */
class DatabaseRunner {
  constructor(private readonly database: SpannerDriverDatabase) {}

  async run(
    request: SpannerSqlRequest,
    isDml: boolean,
    staleness?: SpannerTimestampBounds,
  ): Promise<SpannerDriverRow[]> {
    if (!isDml) {
      const [rows] = staleness
        ? await this.database.run(request, staleness)
        : await this.database.run(request);
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

/** A single-use bounded read cannot run on an open transaction of any kind. */
function rejectStalenessInTransaction(staleness: SpannerTimestampBounds | undefined): void {
  if (staleness) {
    throw new SpannerInvalidArgumentError({
      message:
        'withStaleness is a single-use bounded read and cannot run inside a transaction; run it on the database, or give the read-only transaction a staleness bound instead',
    });
  }
}

/** Everything inside `db.transaction` runs on the one open driver transaction. */
class TransactionRunner {
  constructor(private readonly transaction: SpannerDriverTransaction) {}

  async run(
    request: SpannerSqlRequest,
    _isDml: boolean,
    staleness?: SpannerTimestampBounds,
  ): Promise<SpannerDriverRow[]> {
    rejectStalenessInTransaction(staleness);
    const [rows] = await this.transaction.run(request);
    return rows;
  }
}

/** Read-only transaction: queries run on the snapshot; DML throws typed. */
class SnapshotRunner {
  constructor(private readonly snapshot: SpannerDriverSnapshot) {}

  async run(
    request: SpannerSqlRequest,
    isDml: boolean,
    staleness?: SpannerTimestampBounds,
  ): Promise<SpannerDriverRow[]> {
    if (isDml) {
      throw new SpannerInvalidArgumentError({
        message:
          'DML is not allowed in a read-only transaction; use a read-write db.transaction for writes',
      });
    }
    rejectStalenessInTransaction(staleness);
    const [rows] = await this.snapshot.run(request);
    return rows;
  }
}

/**
 * bufferedMutations transaction: the query builders compile to mutations on
 * the session's sink; anything that reaches the runner has no mutation form.
 */
class MutationModeRunner {
  run(request: SpannerSqlRequest, isDml: boolean): Promise<SpannerDriverRow[]> {
    void request;
    throw new SpannerInvalidArgumentError({
      message: isDml
        ? 'Statements do not execute inside a bufferedMutations transaction; the insert/update/delete builders compile to mutations, and raw SQL needs a read-write transaction'
        : 'Reads are not allowed inside a bufferedMutations transaction; use a read-write or read-only transaction for queries',
    });
  }
}

class MockRunner {
  run(): Promise<SpannerDriverRow[]> {
    throw new Error(NO_CLIENT_MESSAGE);
  }
}

/**
 * `DrizzleConfig` keys carried on the database: `relations` feeds the
 * relational query builder (`db.query`); `cache` is reserved for the cache
 * integration so user config stays stable across milestones.
 */
export interface SpannerDatabaseOptions {
  relations?: AnyRelations;
  cache?: unknown;
}

/** `db.query.<table>` builders derived from the `relations` config. */
export type SpannerRelationalQueries<TRelations extends AnyRelations> = {
  [K in keyof TRelations]: SpannerRelationalQueryBuilder<TRelations, TRelations[K]>;
};

/** Options for a read-write `db.transaction`. */
export interface SpannerTransactionOptions {
  /** ABORTED re-executions allowed on top of the first attempt. */
  maxRetries?: number;
  /** Overall deadline for the driver's retry loop, in milliseconds. */
  timeout?: number;
}

/** Options for a read-only `db.transaction` over the snapshot API. */
export interface SpannerReadOnlyTransactionOptions {
  readOnly: true;
  /** Timestamp bound of the snapshot; omitted means a strong read. */
  staleness?: SpannerStaleness;
}

/**
 * The surface a read-only transaction callback receives: read methods only.
 * DML is absent at the type level and the session throws a typed error as
 * the runtime backstop.
 */
export interface SpannerReadOnlyTransaction<TRelations extends AnyRelations = EmptyRelations> {
  select(): SpannerTransactionSelectBuilder<undefined>;
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerTransactionSelectBuilder<TSelection>;
  $count(table: AnySpannerTable | SQL, where?: SQL): Promise<number>;
  execute<T = Record<string, unknown>[]>(query: SQL): Promise<T>;
  query: SpannerRelationalQueries<TRelations>;
}

/** Options for a `db.transaction` that buffers mutations until commit. */
export interface SpannerMutationTransactionOptions {
  mode: 'bufferedMutations';
}

/**
 * The surface a bufferedMutations transaction callback receives: writes only.
 * Reads have no mutation form; the session throws typed errors as the
 * runtime backstop, including for `.returning()`.
 */
export interface SpannerMutationTransaction {
  insert<TTable extends AnySpannerTable>(table: TTable): SpannerInsertBuilder<TTable>;
  update<TTable extends AnySpannerTable>(table: TTable): SpannerUpdateBuilder<TTable>;
  delete<TTable extends AnySpannerTable>(table: TTable): SpannerDelete<TTable, void>;
  rollback(): never;
}

/**
 * The surface a read-write transaction callback receives. Identical to
 * `SpannerTransaction` except that its select type omits `withStaleness`
 * (single-use bounded reads cannot run on an open transaction).
 */
export type SpannerReadWriteTransaction<TRelations extends AnyRelations = EmptyRelations> = Omit<
  SpannerTransaction<TRelations>,
  'select'
> & {
  select(): SpannerTransactionSelectBuilder<undefined>;
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection,
  ): SpannerTransactionSelectBuilder<TSelection>;
};

export class SpannerDatabase<TRelations extends AnyRelations = EmptyRelations> {
  static readonly [entityKind]: string = 'SpannerDatabase';

  /** Relational queries over the `relations` config: `db.query.<table>.findMany(...)`. */
  readonly query: SpannerRelationalQueries<TRelations>;

  constructor(
    /** @internal */
    readonly dialect: SpannerDialect,
    /** @internal */
    readonly session: SpannerSession,
    readonly $client: SpannerDriverDatabase | undefined,
    /** @internal */
    readonly options: SpannerDatabaseOptions = {},
  ) {
    const query = {} as Record<string, SpannerRelationalQueryBuilder<TRelations, never>>;
    for (const [tableName, tableConfig] of Object.entries(options.relations ?? {})) {
      query[tableName] = new SpannerRelationalQueryBuilder(
        options.relations!,
        tableConfig.table as SpannerTable,
        tableConfig,
        dialect,
        session,
      );
    }
    this.query = query as SpannerRelationalQueries<TRelations>;
  }

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
   *
   * `timeout` bounds the driver's retry loop (milliseconds); `maxRetries`
   * bounds the number of ABORTED re-executions on top of the first attempt.
   */
  transaction<T>(
    callback: (tx: SpannerReadOnlyTransaction<TRelations>) => Promise<T>,
    options: SpannerReadOnlyTransactionOptions,
  ): Promise<T>;
  transaction<T>(
    callback: (tx: SpannerMutationTransaction) => Promise<T>,
    options: SpannerMutationTransactionOptions,
  ): Promise<T>;
  transaction<T>(
    callback: (tx: SpannerReadWriteTransaction<TRelations>) => Promise<T>,
    options?: SpannerTransactionOptions,
  ): Promise<T>;
  async transaction<T>(
    callback: (tx: never) => Promise<T>,
    options:
      | SpannerTransactionOptions
      | SpannerReadOnlyTransactionOptions
      | SpannerMutationTransactionOptions = {},
  ): Promise<T> {
    const client = this.$client;
    if (!client) {
      throw new Error('Cannot start a transaction on a mock database: no client is attached');
    }
    if ('readOnly' in options) {
      return this.readOnlyTransaction(
        callback as (tx: SpannerReadOnlyTransaction<TRelations>) => Promise<T>,
        client,
        options,
      );
    }
    const bufferedMutations = 'mode' in options;
    const { maxRetries, timeout } = bufferedMutations ? ({} as SpannerTransactionOptions) : options;
    const runCallback = callback as (tx: SpannerTransaction<TRelations>) => Promise<T>;
    let attempts = 0;
    try {
      const runFn = async (driverTransaction: SpannerDriverTransaction): Promise<T> => {
        attempts += 1;
        // The SpannerAbortedError carries no gRPC code here on purpose: the
        // driver's runner would treat a coded ABORTED as retryable.
        if (maxRetries !== undefined && attempts > maxRetries + 1) {
          throw new SpannerAbortedError({
            message: `Read-write transaction aborted and maxRetries (${maxRetries}) was exhausted`,
          });
        }
        const transactionSession = bufferedMutations
          ? new SpannerSession(
              new MutationModeRunner(),
              this.dialect,
              this.session.options,
              driverTransaction,
            )
          : new SpannerSession(
              new TransactionRunner(driverTransaction),
              this.dialect,
              this.session.options,
            );
        const tx = new SpannerTransaction<TRelations>(
          this.dialect,
          transactionSession,
          this.$client,
          this.options,
        );
        try {
          const result = await runCallback(tx);
          await driverTransaction.commit();
          return result;
        } catch (error) {
          // The rollback is best-effort in every branch: on ABORTED it
          // releases locks a still-open server transaction may hold (a real
          // abort makes it a no-op), then the error propagates untouched so
          // the driver's transaction runner retries the whole callback.
          try {
            await driverTransaction.rollback();
          } catch {
            // The original error matters more.
          }
          throw error;
        }
      };
      return timeout === undefined
        ? await client.runTransactionAsync(runFn)
        : await client.runTransactionAsync({ timeout }, runFn);
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

  /**
   * Read-only transaction over `database.getSnapshot`: every query in the
   * callback reads from the one snapshot, so multi-statement reads are
   * consistent. There is nothing to commit; the snapshot ends afterwards.
   */
  private async readOnlyTransaction<T>(
    callback: (tx: SpannerReadOnlyTransaction<TRelations>) => Promise<T>,
    client: SpannerDriverDatabase,
    options: SpannerReadOnlyTransactionOptions,
  ): Promise<T> {
    const bounds = options.staleness && toTimestampBounds(options.staleness);
    let snapshot: SpannerDriverSnapshot;
    try {
      [snapshot] = bounds ? await client.getSnapshot(bounds) : await client.getSnapshot();
    } catch (error) {
      throw wrapSpannerError(error);
    }
    try {
      const snapshotSession = new SpannerSession(
        new SnapshotRunner(snapshot),
        this.dialect,
        this.session.options,
      );
      const tx = new SpannerTransaction<TRelations>(
        this.dialect,
        snapshotSession,
        this.$client,
        this.options,
      );
      return await callback(tx);
    } catch (error) {
      throw wrapSpannerError(error);
    } finally {
      snapshot.end();
    }
  }
}

export class SpannerTransaction<
  TRelations extends AnyRelations = EmptyRelations,
> extends SpannerDatabase<TRelations> {
  static override readonly [entityKind]: string = 'SpannerTransaction';

  override transaction<T>(
    _callback: (tx: never) => Promise<T>,
    _options?:
      | SpannerTransactionOptions
      | SpannerReadOnlyTransactionOptions
      | SpannerMutationTransactionOptions,
  ): Promise<T> {
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
