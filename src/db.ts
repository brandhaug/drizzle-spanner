import { entityKind } from 'drizzle-orm/entity'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { type AnyRelations, type EmptyRelations } from 'drizzle-orm/relations'
import { type SQL } from 'drizzle-orm/sql'
import { type SpannerDialect } from './dialect.js'
import {
  GrpcStatus,
  SpannerAbortedError,
  SpannerInvalidArgumentError,
  wrapSpannerError
} from './errors.js'
import {
  type SpannerMultiUseStaleness,
  type SpannerTimestampBounds
} from './staleness.js'
import { toTimestampBounds } from './staleness.js'
import {
  type SpannerDriverRow,
  type SpannerQueryRunner,
  type SpannerRunOptions,
  type SpannerSqlRequest
} from './session.js'
import { NO_CLIENT_MESSAGE, SpannerSession } from './session.js'
import { type SpannerMutationSink } from './mutations.js'
import { MUTATION_MODE_READ_MESSAGE } from './mutations.js'
import { unwrapDriverWrapper } from './columns/common.js'
import { SpannerDelete } from './query-builders/delete.js'
import { SpannerInsertBuilder } from './query-builders/insert.js'
import { SpannerRelationalQueryBuilder } from './query-builders/query.js'
import { type SpannerTransactionRaw } from './query-builders/raw.js'
import { SpannerRaw } from './query-builders/raw.js'
import {
  type SpannerSelectedFields,
  type SpannerTransactionSelectBuilder
} from './query-builders/select.js'
import { SpannerSelectBuilder } from './query-builders/select.js'
import { SpannerUpdateBuilder } from './query-builders/update.js'
import { type AnySpannerTable, type SpannerTable } from './table.js'

/**
 * Structural view of the `@google-cloud/spanner` surfaces this adapter uses.
 * `drizzle()` takes the real `Database`; these types keep the runtime free of
 * a hard import so unit tests and `drizzle.mock()` need no driver install.
 */
export interface SpannerDriverTransaction {
  run(request: SpannerSqlRequest): Promise<[Array<SpannerDriverRow>, ...Array<unknown>]>
  commit(): Promise<unknown>
  rollback(): Promise<unknown>
  /** Mutation buffer used by the bufferedMutations transaction mode. */
  insert(table: string, rows: Array<Record<string, unknown>>): void
  update(table: string, rows: Array<Record<string, unknown>>): void
  upsert(table: string, rows: Array<Record<string, unknown>>): void
  deleteRows(table: string, keys: Array<Array<unknown>>): void
}

/** Options the driver's transaction runner accepts (`RunTransactionOptions`). */
export interface SpannerDriverRunTransactionOptions {
  timeout?: number
}

/** A read-only snapshot from `database.getSnapshot`. */
export interface SpannerDriverSnapshot {
  run(request: SpannerSqlRequest): Promise<[Array<SpannerDriverRow>, ...Array<unknown>]>
  /** Used for reads given a signal: destroying the stream cancels the gRPC call. */
  runStream(request: SpannerSqlRequest): SpannerDriverRowStream
  end(): void
}

/** The driver's row stream (`PartialResultStream`): async-iterable and destroyable. */
export interface SpannerDriverRowStream extends AsyncIterable<SpannerDriverRow> {
  destroy(error?: Error): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** A driver session (`Session`). A snapshot made on it and never begun reads single-use. */
export interface SpannerDriverSession {
  snapshot(
    bounds?: SpannerTimestampBounds,
    queryOptions?: unknown
  ): SpannerDriverSnapshot
}

/** The driver's session source, `database.sessionFactory_` (driver 8 and later). */
export interface SpannerDriverSessionFactory {
  getSession(
    callback: (error: Error | null, session?: SpannerDriverSession | null) => void
  ): void
  /** True when `getSession` hands out the shared multiplexed session, which is never released. */
  isMultiplexedEnabled?(): boolean
}

export interface SpannerDriverDatabase {
  /** Database-level query options the driver sends with every read. */
  queryOptions_?: unknown
  sessionFactory_?: SpannerDriverSessionFactory
  run(
    request: SpannerSqlRequest,
    bounds?: SpannerTimestampBounds
  ): Promise<[Array<SpannerDriverRow>, ...Array<unknown>]>
  runTransactionAsync<T>(
    runFn: (transaction: SpannerDriverTransaction) => Promise<T>
  ): Promise<T>
  runTransactionAsync<T>(
    options: SpannerDriverRunTransactionOptions,
    runFn: (transaction: SpannerDriverTransaction) => Promise<T>
  ): Promise<T>
  getSnapshot(
    bounds?: SpannerTimestampBounds
  ): Promise<readonly [SpannerDriverSnapshot, ...Array<unknown>]>
}

/** Reads on `database.run`; each standalone DML statement in its own read-write transaction. */
class DatabaseRunner {
  constructor(private readonly database: SpannerDriverDatabase) {}

  async run(
    request: SpannerSqlRequest,
    isDml: boolean,
    { staleness, signal }: SpannerRunOptions = {}
  ): Promise<Array<SpannerDriverRow>> {
    if (!isDml && signal) {
      return readCancellable(this.database, request, staleness, signal)
    }
    if (!isDml) {
      const [rows] = staleness
        ? await this.database.run(request, staleness)
        : await this.database.run(request)
      return rows
    }
    // database.run is read-only; DML (with THEN RETURN) must go through a
    // read-write transaction, and txn.run (not runUpdate) yields the rows.
    return this.database.runTransactionAsync(async (transaction) => {
      const [rows] = await transaction.run(request)
      await transaction.commit()
      return rows
    })
  }
}

/**
 * A cancellable read. It streams from a driver snapshot because destroying a
 * snapshot's row stream cancels its gRPC call; the stream `database.runStream`
 * returns is a proxy whose destruction leaves the call running.
 */
async function readCancellable(
  database: SpannerDriverDatabase,
  request: SpannerSqlRequest,
  staleness: SpannerTimestampBounds | undefined,
  signal: AbortSignal
): Promise<Array<SpannerDriverRow>> {
  const snapshot = await openCancellableSnapshot(database, staleness, signal)
  try {
    return await readStream(snapshot.runStream(request), signal)
  } finally {
    snapshot.end()
  }
}

/**
 * On a multiplexed session (always, from driver 9.1) the snapshot is never
 * begun, so the read is single-use, as `database.run` reads: no BeginTransaction
 * round trip, and every staleness bound applies. A pooled session would have to
 * go back to the driver's pool, which it does not expose, so without
 * multiplexing the read runs on `database.getSnapshot`: a read-only transaction
 * that costs one BeginTransaction and takes no single-use bound.
 */
async function openCancellableSnapshot(
  database: SpannerDriverDatabase,
  staleness: SpannerTimestampBounds | undefined,
  signal: AbortSignal
): Promise<SpannerDriverSnapshot> {
  const sessions = database.sessionFactory_
  if (sessions?.isMultiplexedEnabled?.()) {
    const session = await untilAborted(multiplexedSession(sessions), signal)
    return session.snapshot(staleness, database.queryOptions_)
  }
  if (
    staleness?.maxStaleness !== undefined ||
    staleness?.minReadTimestamp !== undefined
  ) {
    throw new SpannerInvalidArgumentError({
      message:
        'withSignal reads on a read-only snapshot unless the driver uses multiplexed sessions; a snapshot takes an exact staleness or a read timestamp, and maxStaleness and minReadTimestamp are single-use bounds'
    })
  }
  const opening = database.getSnapshot(staleness).then(([snapshot]) => snapshot)
  return untilAborted(opening, signal, (late) => late.end())
}

function multiplexedSession(
  sessions: SpannerDriverSessionFactory
): Promise<SpannerDriverSession> {
  const { promise, resolve, reject } = Promise.withResolvers<SpannerDriverSession>()
  sessions.getSession((error, session) => {
    if (error || !session) {
      reject(error ?? new Error('The driver returned no session'))
      return
    }
    resolve(session)
  })
  return promise
}

/**
 * `pending`, or the signal's reason as soon as it aborts. `release` disposes of
 * a value that arrives after the abort.
 */
async function untilAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  release?: (late: T) => void
): Promise<T> {
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const onAbort = (): void => {
    reject(signal.reason)
    pending.then(release).catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Collects a row stream; aborting the signal destroys it. */
async function readStream(
  stream: SpannerDriverRowStream,
  signal: AbortSignal
): Promise<Array<SpannerDriverRow>> {
  // An error the stream emits before iteration attaches its own listener must not go unhandled.
  stream.on('error', () => undefined)
  const cancel = (): void => {
    stream.destroy(
      signal.reason instanceof Error ? signal.reason : new Error('aborted')
    )
  }
  if (signal.aborted) {
    cancel()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Array.fromAsync(stream)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** A single-use bounded read or a cancellable read cannot run on an open transaction of any kind. */
function rejectSingleUseOptionsInTransaction({
  staleness,
  signal
}: SpannerRunOptions): void {
  if (staleness) {
    throw new SpannerInvalidArgumentError({
      message:
        'withStaleness is a single-use bounded read and cannot run inside a transaction; run it on the database, or give the read-only transaction a staleness bound instead'
    })
  }
  if (signal) {
    throw new SpannerInvalidArgumentError({
      message:
        'withSignal cancels single-use reads on the database; inside a transaction the driver retries the whole callback, so cancel the transaction instead'
    })
  }
}

/** Everything inside `db.transaction` runs on the one open driver transaction. */
class TransactionRunner {
  constructor(private readonly transaction: SpannerDriverTransaction) {}

  async run(
    request: SpannerSqlRequest,
    _isDml: boolean,
    options: SpannerRunOptions = {}
  ): Promise<Array<SpannerDriverRow>> {
    rejectSingleUseOptionsInTransaction(options)
    const [rows] = await this.transaction.run(request)
    return rows
  }
}

/** Read-only transaction: queries run on the snapshot; DML throws typed. */
class SnapshotRunner {
  constructor(private readonly snapshot: SpannerDriverSnapshot) {}

  async run(
    request: SpannerSqlRequest,
    isDml: boolean,
    options: SpannerRunOptions = {}
  ): Promise<Array<SpannerDriverRow>> {
    if (isDml) {
      throw new SpannerInvalidArgumentError({
        message:
          'DML is not allowed in a read-only transaction; use a read-write db.transaction for writes'
      })
    }
    rejectSingleUseOptionsInTransaction(options)
    const [rows] = await this.snapshot.run(request)
    return rows
  }
}

/**
 * bufferedMutations transaction: the query builders compile to mutations on
 * the session's sink; anything that reaches the runner has no mutation form.
 */
class MutationModeRunner {
  run(request: SpannerSqlRequest, isDml: boolean): Promise<Array<SpannerDriverRow>> {
    void request
    throw new SpannerInvalidArgumentError({
      message: isDml
        ? 'Statements do not execute inside a bufferedMutations transaction; the insert/update/delete builders compile to mutations, and raw SQL needs a read-write transaction'
        : MUTATION_MODE_READ_MESSAGE
    })
  }
}

class MockRunner {
  run(): Promise<Array<SpannerDriverRow>> {
    throw new Error(NO_CLIENT_MESSAGE)
  }
}

/**
 * Internal signal that `maxRetries` ran out. It deliberately carries no gRPC
 * code while inside the driver's retry runner — a coded ABORTED would be
 * retried — and is converted to a coded `SpannerAbortedError` once the
 * runner exits.
 */
class MaxRetriesExhaustedError extends Error {}

/**
 * `DrizzleConfig` keys carried on the database: `relations` feeds the
 * relational query builder (`db.query`).
 */
export interface SpannerDatabaseOptions {
  relations?: AnyRelations
}

/** `db.query.<table>` builders derived from the `relations` config. */
export type SpannerRelationalQueries<TRelations extends AnyRelations> = {
  [K in keyof TRelations]: SpannerRelationalQueryBuilder<TRelations, TRelations[K]>
}

/** Options for a read-write `db.transaction`. */
export interface SpannerTransactionOptions {
  /** ABORTED re-executions allowed on top of the first attempt. */
  maxRetries?: number
  /** Overall deadline for the driver's retry loop, in milliseconds. */
  timeout?: number
}

/** Options for a read-only `db.transaction` over the snapshot API. */
export interface SpannerReadOnlyTransactionOptions {
  readOnly: true
  /**
   * Timestamp bound of the snapshot; omitted means a strong read. Single-use
   * bounds (`maxStaleness`, `minReadTimestamp`) are excluded at the type
   * level — Spanner rejects them on multi-use snapshots.
   */
  staleness?: SpannerMultiUseStaleness
}

/**
 * The surface a read-only transaction callback receives: read methods only.
 * DML is absent at the type level and the session throws a typed error as
 * the runtime backstop.
 */
export interface SpannerReadOnlyTransaction<
  TRelations extends AnyRelations = EmptyRelations
> {
  select(): SpannerTransactionSelectBuilder<undefined>
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection
  ): SpannerTransactionSelectBuilder<TSelection>
  $count(table: AnySpannerTable | SQL, where?: SQL): Promise<number>
  execute<T = Array<Record<string, unknown>>>(query: SQL): SpannerTransactionRaw<T>
  query: SpannerRelationalQueries<TRelations>
}

/** Options for a `db.transaction` that buffers mutations until commit. */
export interface SpannerMutationTransactionOptions {
  mode: 'bufferedMutations'
}

/**
 * The surface a bufferedMutations transaction callback receives: writes only.
 * Reads have no mutation form; the session throws typed errors as the
 * runtime backstop, including for `.returning()`.
 */
export interface SpannerMutationTransaction {
  insert<TTable extends AnySpannerTable>(table: TTable): SpannerInsertBuilder<TTable>
  update<TTable extends AnySpannerTable>(table: TTable): SpannerUpdateBuilder<TTable>
  delete<TTable extends AnySpannerTable>(table: TTable): SpannerDelete<TTable, void>
  rollback(): never
}

/**
 * The surface a read-write transaction callback receives. Identical to
 * `SpannerTransaction` except that its selects omit `withStaleness` (single-use
 * bounded reads cannot run on an open transaction), and its selects and raw SQL
 * omit `withSignal` (the driver retries the whole callback).
 */
export type SpannerReadWriteTransaction<
  TRelations extends AnyRelations = EmptyRelations
> = Omit<SpannerTransaction<TRelations>, 'select' | 'execute'> & {
  select(): SpannerTransactionSelectBuilder<undefined>
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection
  ): SpannerTransactionSelectBuilder<TSelection>
  execute<T = Array<Record<string, unknown>>>(query: SQL): SpannerTransactionRaw<T>
}

/**
 * Query surface shared by the database and the transaction objects. Holding
 * `transaction()` on `SpannerDatabase` only (and `rollback()` on
 * `SpannerTransaction` only) keeps each subclass from refusing what it
 * inherits.
 */
export class SpannerDatabaseCore<TRelations extends AnyRelations = EmptyRelations> {
  static readonly [entityKind]: string = 'SpannerDatabaseCore'

  /** Relational queries over the `relations` config: `db.query.<table>.findMany(...)`. */
  readonly query: SpannerRelationalQueries<TRelations>

  constructor(
    /** @internal */
    readonly dialect: SpannerDialect,
    /** @internal */
    readonly session: SpannerSession,
    readonly $client: SpannerDriverDatabase | undefined,
    /** @internal */
    readonly options: SpannerDatabaseOptions = {}
  ) {
    const query = {} as Record<string, SpannerRelationalQueryBuilder<TRelations, never>>
    for (const [tableName, tableConfig] of Object.entries(options.relations ?? {})) {
      query[tableName] = new SpannerRelationalQueryBuilder(
        options.relations!,
        tableConfig.table as SpannerTable,
        tableConfig,
        dialect,
        session
      )
    }
    this.query = query as SpannerRelationalQueries<TRelations>
  }

  select(): SpannerSelectBuilder<undefined>
  select<TSelection extends SpannerSelectedFields>(
    fields: TSelection
  ): SpannerSelectBuilder<TSelection>
  select(
    fields?: SpannerSelectedFields
  ): SpannerSelectBuilder<SpannerSelectedFields | undefined> {
    return new SpannerSelectBuilder(fields, this.session, this.dialect)
  }

  insert<TTable extends AnySpannerTable>(table: TTable): SpannerInsertBuilder<TTable> {
    return new SpannerInsertBuilder(table, this.session, this.dialect)
  }

  update<TTable extends AnySpannerTable>(table: TTable): SpannerUpdateBuilder<TTable> {
    return new SpannerUpdateBuilder(table, this.session, this.dialect)
  }

  delete<TTable extends AnySpannerTable>(table: TTable): SpannerDelete<TTable, void> {
    return new SpannerDelete(table, this.session, this.dialect)
  }

  /** `select count(*) from table [where ...]` returning a number. */
  async $count(table: AnySpannerTable | SQL, where?: SQL): Promise<number> {
    const query = this.dialect.sqlToQuery(this.dialect.buildCountQuery(table, where))
    const prepared = this.session.prepareQuery<number>(query, undefined, (rows) =>
      Number(unwrapDriverWrapper(rows[0]?.[0]))
    )
    return prepared.execute()
  }

  /** Raw SQL escape hatch; rows arrive as the driver's `toJSON()` objects. */
  execute<T = Array<Record<string, unknown>>>(query: SQL): SpannerRaw<T> {
    return new SpannerRaw<T>(query, this.session, this.dialect)
  }
}

export class SpannerDatabase<
  TRelations extends AnyRelations = EmptyRelations
> extends SpannerDatabaseCore<TRelations> {
  static override readonly [entityKind]: string = 'SpannerDatabase'

  /** One transaction-scoped session and its query surface. */
  private createTransactionScope(
    runner: SpannerQueryRunner,
    mutationSink?: SpannerMutationSink
  ): SpannerTransaction<TRelations> {
    const session = new SpannerSession(
      runner,
      this.dialect,
      this.session.options,
      mutationSink
    )
    return new SpannerTransaction<TRelations>(
      this.dialect,
      session,
      this.$client,
      this.options
    )
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
    options: SpannerReadOnlyTransactionOptions
  ): Promise<T>
  transaction<T>(
    callback: (tx: SpannerMutationTransaction) => Promise<T>,
    options: SpannerMutationTransactionOptions
  ): Promise<T>
  transaction<T>(
    callback: (tx: SpannerReadWriteTransaction<TRelations>) => Promise<T>,
    options?: SpannerTransactionOptions
  ): Promise<T>
  async transaction<T>(
    callback: (tx: never) => Promise<T>,
    options:
      | SpannerTransactionOptions
      | SpannerReadOnlyTransactionOptions
      | SpannerMutationTransactionOptions = {}
  ): Promise<T> {
    const client = this.$client
    if (!client) {
      throw new Error(
        'Cannot start a transaction on a mock database: no client is attached'
      )
    }
    if ('readOnly' in options) {
      return this.readOnlyTransaction(
        callback as (tx: SpannerReadOnlyTransaction<TRelations>) => Promise<T>,
        client,
        options
      )
    }
    const bufferedMutations = 'mode' in options
    const { maxRetries, timeout } = bufferedMutations
      ? ({} as SpannerTransactionOptions)
      : options
    const runCallback = callback as (tx: SpannerTransaction<TRelations>) => Promise<T>
    let attempts = 0
    try {
      const runFn = async (driverTransaction: SpannerDriverTransaction): Promise<T> => {
        attempts += 1
        if (maxRetries !== undefined && attempts > maxRetries + 1) {
          throw new MaxRetriesExhaustedError(
            `Read-write transaction aborted and maxRetries (${maxRetries}) was exhausted`
          )
        }
        const tx = bufferedMutations
          ? this.createTransactionScope(new MutationModeRunner(), driverTransaction)
          : this.createTransactionScope(new TransactionRunner(driverTransaction))
        try {
          const result = await runCallback(tx)
          await driverTransaction.commit()
          return result
        } catch (error) {
          // The rollback is best-effort in every branch: on ABORTED it
          // releases locks a still-open server transaction may hold (a real
          // abort makes it a no-op), then the error propagates untouched so
          // the driver's transaction runner retries the whole callback.
          try {
            await driverTransaction.rollback()
          } catch {
            // The original error matters more.
          }
          throw error
        }
      }
      return timeout === undefined
        ? await client.runTransactionAsync(runFn)
        : await client.runTransactionAsync({ timeout }, runFn)
    } catch (error) {
      // Outside the driver's runner a gRPC code is safe to attach (spec:
      // each variant carries the status code).
      if (error instanceof MaxRetriesExhaustedError) {
        throw new SpannerAbortedError({
          message: error.message,
          code: GrpcStatus.ABORTED
        })
      }
      // The driver's DeadlineError means ABORTED retries ran out of time.
      if ((error as { name?: string } | null | undefined)?.name === 'DeadlineError') {
        throw new SpannerAbortedError({
          message: 'Read-write transaction aborted and retries were exhausted',
          code: GrpcStatus.ABORTED,
          cause: error
        })
      }
      throw wrapSpannerError(error)
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
    options: SpannerReadOnlyTransactionOptions
  ): Promise<T> {
    const bounds = options.staleness && toTimestampBounds(options.staleness)
    let snapshot: SpannerDriverSnapshot
    try {
      ;[snapshot] = bounds
        ? await client.getSnapshot(bounds)
        : await client.getSnapshot()
    } catch (error) {
      throw wrapSpannerError(error)
    }
    try {
      const tx = this.createTransactionScope(new SnapshotRunner(snapshot))
      return await callback(tx)
    } catch (error) {
      throw wrapSpannerError(error)
    } finally {
      snapshot.end()
    }
  }
}

export class SpannerTransaction<
  TRelations extends AnyRelations = EmptyRelations
> extends SpannerDatabaseCore<TRelations> {
  static override readonly [entityKind]: string = 'SpannerTransaction'

  /**
   * Absent from the transaction types; this runtime backstop catches callers
   * who reach it through a database-typed reference.
   */
  transaction(): never {
    throw new Error('Spanner does not support nested transactions (no savepoints)')
  }

  /** Aborts the transaction by throwing `TransactionRollbackError`. */
  rollback(): never {
    throw new TransactionRollbackError()
  }
}

export function createDatabaseSession(
  database: SpannerDriverDatabase,
  dialect: SpannerDialect,
  options?: { logger?: SpannerSession['logger'] }
): SpannerSession {
  return new SpannerSession(new DatabaseRunner(database), dialect, options)
}

export function createMockSession(dialect: SpannerDialect): SpannerSession {
  return new SpannerSession(new MockRunner(), dialect, {})
}
