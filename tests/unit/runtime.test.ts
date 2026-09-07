import { describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm/sql'
import { and, eq, gt } from 'drizzle-orm/sql/expressions'
import {
  commitTimestamp,
  drizzle,
  GrpcStatus,
  int64,
  primaryKey,
  SpannerAbortedError,
  SpannerInvalidArgumentError,
  spannerTable,
  string,
  timestamp
} from '../../src/index.js'
import {
  type SpannerDatabase,
  type SpannerDriverDatabase,
  type SpannerDriverRow,
  type SpannerDriverTransaction,
  type SpannerSqlRequest
} from '../../src/index.js'

// bun:test has no .rejects.toSatisfy(); assert the rejection with a predicate.
async function rejectsMatching<T>(
  promise: Promise<T>,
  predicate: (error: unknown) => boolean
): Promise<void> {
  const rejection = await promise.then(
    () => {
      throw new Error('expected promise to reject, but it resolved')
    },
    (error: unknown) => error
  )
  if (!predicate(rejection)) {
    throw new Error(`rejected value did not match predicate: ${String(rejection)}`)
  }
}

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull()
})

function abortedError(): Error & { code: number } {
  return Object.assign(new Error('Transaction aborted'), { code: GrpcStatus.ABORTED })
}

/**
 * Fake @google-cloud/spanner Database whose runTransactionAsync mimics the
 * driver's retry loop: the callback re-runs while it throws ABORTED, up to a
 * cap standing in for the driver's deadline.
 */
function fakeRetryingDatabase(retryCap = 25) {
  const recordedOptions: Array<unknown> = []
  let attempts = 0
  const transaction: SpannerDriverTransaction = {
    async run(request: SpannerSqlRequest) {
      void request
      return [[]]
    },
    async commit() {
      return
    },
    async rollback() {
      return
    },
    insert() {},
    update() {},
    upsert() {},
    deleteRows() {}
  }
  const database = {
    async run() {
      return [[]]
    },
    async runTransactionAsync<T>(
      optionsOrRunFn:
        | { timeout?: number }
        | ((tx: SpannerDriverTransaction) => Promise<T>),
      maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>
    ): Promise<T> {
      const runFn = typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!
      recordedOptions.push(
        typeof optionsOrRunFn === 'function' ? undefined : optionsOrRunFn
      )
      for (let i = 0; i < retryCap; i++) {
        attempts += 1
        try {
          return await runFn(transaction)
        } catch (error) {
          if ((error as { code?: unknown }).code === GrpcStatus.ABORTED) {
            continue
          }
          throw error
        }
      }
      throw Object.assign(new Error('Deadline for Transaction exceeded.'), {
        name: 'DeadlineError'
      })
    },
    async getSnapshot(): Promise<never> {
      throw new Error('read-write fakes take no snapshots')
    }
  } satisfies SpannerDriverDatabase & Record<string, unknown>
  return {
    database: database as SpannerDriverDatabase,
    recordedOptions,
    attemptCount: () => attempts
  }
}

/** Fake database whose getSnapshot records bounds and serves a read-only snapshot. */
function fakeSnapshotDatabase(
  rows: Array<Array<{ name: string; value: unknown }>> = []
) {
  const snapshotBounds: Array<unknown> = []
  const snapshotRequests: Array<SpannerSqlRequest> = []
  let ended = 0
  const database = {
    async run() {
      return [[]] as [Array<SpannerDriverRow>]
    },
    async runTransactionAsync<T>(
      optionsOrRunFn:
        | { timeout?: number }
        | ((tx: SpannerDriverTransaction) => Promise<T>),
      maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>
    ): Promise<T> {
      void optionsOrRunFn
      void maybeRunFn
      throw new Error('read-only transactions must not open a read-write transaction')
    },
    async getSnapshot(bounds?: unknown) {
      snapshotBounds.push(bounds)
      return [
        {
          async run(request: SpannerSqlRequest) {
            snapshotRequests.push(request)
            return [rows] as [Array<SpannerDriverRow>]
          },
          end() {
            ended += 1
          }
        }
      ] as const
    }
  }
  return {
    database: database as SpannerDriverDatabase,
    snapshotBounds,
    snapshotRequests,
    endCount: () => ended
  }
}

describe('transaction options', () => {
  it('threads timeout into runTransactionAsync options', async () => {
    const fake = fakeRetryingDatabase()
    const db = drizzle(fake.database)
    await db.transaction(async () => 'ok', { timeout: 5000 })
    expect(fake.recordedOptions).toEqual([{ timeout: 5000 }])
  })

  it('passes no options object when none are given', async () => {
    const fake = fakeRetryingDatabase()
    const db = drizzle(fake.database)
    await db.transaction(async () => 'ok')
    expect(fake.recordedOptions).toEqual([undefined])
  })

  it('keeps transparent ABORTED retries and resolves on a later attempt', async () => {
    const fake = fakeRetryingDatabase()
    const db = drizzle(fake.database)
    let calls = 0
    const result = await db.transaction(async (tx) => {
      calls += 1
      if (calls < 3) {
        throw abortedError()
      }
      const rows = await tx.select().from(singers)
      void rows
      return 'done'
    })
    expect(result).toBe('done')
    expect(calls).toBe(3)
  })

  it('throws a coded SpannerAbortedError once maxRetries is exhausted', async () => {
    const fake = fakeRetryingDatabase()
    const db = drizzle(fake.database)
    let calls = 0
    const failing = db.transaction(
      async () => {
        calls += 1
        throw abortedError()
      },
      { maxRetries: 2 }
    )
    await expect(failing).rejects.toBeInstanceOf(SpannerAbortedError)
    // The surfaced error carries the gRPC code (spec: error handling); the
    // code is attached only after the driver's retry runner exits.
    await expect(failing).rejects.toMatchObject({ code: GrpcStatus.ABORTED })
    // maxRetries = 2 means one initial attempt plus two retries.
    expect(calls).toBe(3)
  })
})

describe('read-only transactions', () => {
  it('runs queries on a snapshot and ends it afterwards', async () => {
    const fake = fakeSnapshotDatabase([
      [
        { name: 'id', value: 'x' },
        { name: 'name', value: 'Ada' }
      ]
    ])
    const db = drizzle(fake.database)
    const result = await db.transaction(async (tx) => tx.select().from(singers), {
      readOnly: true
    })
    expect(result).toEqual([{ id: 'x', name: 'Ada' }])
    expect(fake.snapshotBounds).toEqual([undefined])
    expect(fake.snapshotRequests).toHaveLength(1)
    expect(fake.endCount()).toBe(1)
  })

  it('ends the snapshot when the callback throws', async () => {
    const fake = fakeSnapshotDatabase()
    const db = drizzle(fake.database)
    await expect(
      db.transaction(
        async () => {
          throw new Error('boom')
        },
        { readOnly: true }
      )
    ).rejects.toThrow('boom')
    expect(fake.endCount()).toBe(1)
  })

  it('encodes staleness bounds into driver timestamp bounds', async () => {
    const fake = fakeSnapshotDatabase()
    const db = drizzle(fake.database)
    const readAt = new Date('2026-07-30T10:00:00.250Z')

    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { strong: true }
    })
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { exactStaleness: '15s' }
    })
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { exactStaleness: 500 }
    })
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { readTimestamp: readAt }
    })

    expect(fake.snapshotBounds).toEqual([
      { strong: true },
      // The driver's numeric convenience form for staleness is milliseconds.
      { exactStaleness: 15_000 },
      { exactStaleness: 500 },
      // Timestamps encode to protobuf form; a plain Date would be misread.
      { readTimestamp: { seconds: 1_785_405_600, nanos: 250_000_000 } }
    ])
  })

  it('rejects an unparseable staleness duration with a typed error', async () => {
    const fake = fakeSnapshotDatabase()
    const db = drizzle(fake.database)
    await expect(
      db.transaction(async () => undefined, {
        readOnly: true,
        staleness: { exactStaleness: 'fifteen seconds' }
      })
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
  })

  it('exposes only read methods at the type level and throws typed on DML at runtime', async () => {
    const fake = fakeSnapshotDatabase()
    const db = drizzle(fake.database)
    await expect(
      db.transaction(
        async (tx) => {
          // @ts-expect-error — the read-only transaction type has no insert
          void tx.insert
          // The runtime backstop: raw DML through the session runner.
          await tx.execute(sql`update singers set name = 'x' where true`)
        },
        { readOnly: true }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
    expect(fake.endCount()).toBe(1)
  })
})

describe('single-use stale reads (withStaleness)', () => {
  function fakeBoundedReadDatabase(
    rows: Array<Array<{ name: string; value: unknown }>> = []
  ) {
    const runBounds: Array<unknown> = []
    const database = {
      async run(request: SpannerSqlRequest, bounds?: unknown) {
        void request
        runBounds.push(bounds)
        return [rows] as [Array<SpannerDriverRow>]
      },
      async runTransactionAsync<T>(
        optionsOrRunFn:
          | { timeout?: number }
          | ((tx: SpannerDriverTransaction) => Promise<T>),
        maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>
      ): Promise<T> {
        const runFn =
          typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!
        return runFn({
          async run() {
            return [rows] as [Array<SpannerDriverRow>]
          },
          async commit() {
            return
          },
          async rollback() {
            return
          },
          insert() {},
          update() {},
          upsert() {},
          deleteRows() {}
        })
      },
      async getSnapshot() {
        return [
          {
            async run() {
              return [rows] as [Array<SpannerDriverRow>]
            },
            end() {}
          }
        ] as const
      }
    }
    return { database: database as SpannerDriverDatabase, runBounds }
  }

  it('compiles to a single-use bounded read on database.run', async () => {
    const fake = fakeBoundedReadDatabase([
      [
        { name: 'id', value: 'x' },
        { name: 'name', value: 'Ada' }
      ]
    ])
    const db = drizzle(fake.database)
    const rows = await db
      .select()
      .from(singers)
      .withStaleness({ exactStaleness: '15s' })
    expect(rows).toEqual([{ id: 'x', name: 'Ada' }])
    expect(fake.runBounds).toEqual([{ exactStaleness: 15_000 }])
  })

  it('encodes the single-use-only bounds (maxStaleness, minReadTimestamp)', async () => {
    const fake = fakeBoundedReadDatabase()
    const db = drizzle(fake.database)
    await db.select().from(singers).withStaleness({ maxStaleness: '10s' })
    await db.select().from(singers).withStaleness({ maxStaleness: 250 })
    await db
      .select()
      .from(singers)
      .withStaleness({ minReadTimestamp: '2026-07-30T10:00:00Z' })
    expect(fake.runBounds).toEqual([
      { maxStaleness: 10_000 },
      { maxStaleness: 250 },
      { minReadTimestamp: { seconds: 1_785_405_600, nanos: 0 } }
    ])
  })

  it('leaves ordinary reads unbounded', async () => {
    const fake = fakeBoundedReadDatabase()
    const db = drizzle(fake.database)
    await db.select().from(singers)
    expect(fake.runBounds).toEqual([undefined])
  })

  it('chains with where/orderBy/limit', async () => {
    const fake = fakeBoundedReadDatabase()
    const db = drizzle(fake.database)
    await db
      .select()
      .from(singers)
      .where(sql`true`)
      .orderBy(singers.name)
      .limit(5)
      .withStaleness({ strong: true })
    expect(fake.runBounds).toEqual([{ strong: true }])
  })

  it('is omitted from the transaction-scoped select type and throws typed at runtime', async () => {
    const fake = fakeBoundedReadDatabase()
    const db = drizzle(fake.database)
    await expect(
      db.transaction(async (tx) => {
        const select = tx.select().from(singers)
        // @ts-expect-error — withStaleness is not on the transaction-scoped select
        await select.withStaleness({ strong: true })
      })
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    await expect(
      db.transaction(
        async (tx) => {
          const select = tx.select().from(singers)
          // @ts-expect-error — withStaleness is not on the read-only select either
          await select.withStaleness({ strong: true })
        },
        { readOnly: true }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
  })
})

describe('bufferedMutations transactions', () => {
  const albums = spannerTable(
    'albums',
    {
      singerId: string('singer_id', { length: 36 }).notNull(),
      albumId: string('album_id', { length: 36 }).notNull(),
      title: string('title', { length: 1024 })
    },
    (t) => [primaryKey({ columns: [t.singerId, t.albumId] })]
  )

  const events = spannerTable('events', {
    id: string('id', { length: 36 }).primaryKey(),
    count: int64('count', { mode: 'bigint' }),
    updatedAt: timestamp('updated_at', { allowCommitTimestamp: true })
  })

  interface RecordedMutation {
    kind: 'insert' | 'update' | 'upsert' | 'deleteRows'
    table: string
    payload: unknown
  }

  function fakeMutationDatabase() {
    const mutations: Array<RecordedMutation> = []
    let commits = 0
    let rollbacks = 0
    let runs = 0
    const transaction: SpannerDriverTransaction = {
      async run(request: SpannerSqlRequest) {
        void request
        runs += 1
        return [[]]
      },
      async commit() {
        commits += 1
        return
      },
      async rollback() {
        rollbacks += 1
        return
      },
      insert(table: string, rows: Array<Record<string, unknown>>) {
        mutations.push({ kind: 'insert', table, payload: rows })
      },
      update(table: string, rows: Array<Record<string, unknown>>) {
        mutations.push({ kind: 'update', table, payload: rows })
      },
      upsert(table: string, rows: Array<Record<string, unknown>>) {
        mutations.push({ kind: 'upsert', table, payload: rows })
      },
      deleteRows(table: string, keys: Array<Array<unknown>>) {
        mutations.push({ kind: 'deleteRows', table, payload: keys })
      }
    }
    const database = {
      async run() {
        return [[]] as [Array<SpannerDriverRow>]
      },
      async runTransactionAsync<T>(
        optionsOrRunFn:
          | { timeout?: number }
          | ((tx: SpannerDriverTransaction) => Promise<T>),
        maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>
      ): Promise<T> {
        const runFn =
          typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!
        return runFn(transaction)
      },
      async getSnapshot(): Promise<never> {
        throw new Error('mutation fakes take no snapshots')
      }
    }
    return {
      database: database as SpannerDriverDatabase,
      mutations,
      commitCount: () => commits,
      rollbackCount: () => rollbacks,
      runCount: () => runs
    }
  }

  it('compiles insert values to buffered insert mutations and commits once', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await db.transaction(
      async (tx) => {
        await tx.insert(singers).values([
          { id: 'a', name: 'Ada' },
          { id: 'b', name: 'Grace' }
        ])
      },
      { mode: 'bufferedMutations' }
    )
    expect(fake.mutations).toEqual([
      {
        kind: 'insert',
        table: 'singers',
        payload: [
          { id: 'a', name: 'Ada' },
          { id: 'b', name: 'Grace' }
        ]
      }
    ])
    expect(fake.commitCount()).toBe(1)
    expect(fake.runCount()).toBe(0)
  })

  it('compiles insert().values().orUpdate() to an upsert mutation', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await db.transaction(
      async (tx) => {
        await tx.insert(singers).values({ id: 'a', name: 'Ada' }).orUpdate()
      },
      { mode: 'bufferedMutations' }
    )
    expect(fake.mutations).toEqual([
      { kind: 'upsert', table: 'singers', payload: [{ id: 'a', name: 'Ada' }] }
    ])
    expect(fake.commitCount()).toBe(1)
  })

  it('rejects orIgnore() in a bufferedMutations transaction with a typed error', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await rejectsMatching(
      db.transaction(
        async (tx) => {
          await tx.insert(singers).values({ id: 'a', name: 'Ada' }).orIgnore()
        },
        { mode: 'bufferedMutations' }
      ),
      (error: unknown) =>
        error instanceof SpannerInvalidArgumentError && /orIgnore/.test(error.message)
    )
    expect(fake.mutations).toEqual([])
  })

  it('maps values through mapToDriverValue and the commitTimestamp sentinel', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await db.transaction(
      async (tx) => {
        await tx.insert(events).values({
          id: 'e1',
          count: 9_007_199_254_740_993n,
          updatedAt: commitTimestamp()
        })
      },
      { mode: 'bufferedMutations' }
    )
    expect(fake.mutations).toEqual([
      {
        kind: 'insert',
        table: 'events',
        payload: [
          {
            id: 'e1',
            // bigint rides as a decimal string, same as the DML path.
            count: '9007199254740993',
            updated_at: 'spanner.commit_timestamp()'
          }
        ]
      }
    ])
  })

  it('compiles update with exact primary-key equality to an update mutation', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await db.transaction(
      async (tx) => {
        await tx
          .update(albums)
          .set({ title: 'New Title' })
          .where(and(eq(albums.albumId, 'al1'), eq(albums.singerId, 's1')))
      },
      { mode: 'bufferedMutations' }
    )
    expect(fake.mutations).toEqual([
      {
        kind: 'update',
        table: 'albums',
        payload: [{ singer_id: 's1', album_id: 'al1', title: 'New Title' }]
      }
    ])
  })

  it('rejects update whose WHERE is not exact equality on every key column', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)

    // Missing one primary-key column.
    await expect(
      db.transaction(
        async (tx) => {
          await tx.update(albums).set({ title: 'x' }).where(eq(albums.singerId, 's1'))
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    // A non-equality predicate.
    await expect(
      db.transaction(
        async (tx) => {
          await tx.update(singers).set({ name: 'x' }).where(gt(singers.id, 'a'))
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    // An equality on a non-key column.
    await expect(
      db.transaction(
        async (tx) => {
          await tx
            .update(albums)
            .set({ title: 'x' })
            .where(and(eq(albums.singerId, 's1'), eq(albums.title, 'old')))
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    // No WHERE at all.
    await expect(
      db.transaction(
        async (tx) => {
          await tx.update(singers).set({ name: 'x' })
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    expect(fake.mutations).toEqual([])
  })

  it('rejects repeated key predicates without buffering updates or deletes', async () => {
    for (const secondId of ['a', 'b']) {
      const fake = fakeMutationDatabase()
      const db = drizzle(fake.database)
      const predicate = and(eq(singers.id, 'a'), eq(singers.id, secondId))
      await expect(
        db.transaction(
          async (tx) => {
            await tx.delete(singers).where(predicate)
          },
          { mode: 'bufferedMutations' }
        )
      ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
      await expect(
        db.transaction(
          async (tx) => {
            await tx.update(singers).set({ name: 'changed' }).where(predicate)
          },
          { mode: 'bufferedMutations' }
        )
      ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
      expect(fake.mutations).toEqual([])
    }
  })

  it('rejects unresolved and null key values before buffering a delete', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    for (const value of [null, undefined, sql.placeholder('id'), sql`'a'`]) {
      const predicate = sql`${singers.id} = ${sql.param(value, singers.id)}`
      await expect(
        db.transaction(
          async (tx) => {
            await tx.delete(singers).where(predicate)
          },
          { mode: 'bufferedMutations' }
        )
      ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
    }
    expect(fake.mutations).toEqual([])
  })

  it('compiles delete to key-addressed deleteRows in primary-key order', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await db.transaction(
      async (tx) => {
        // WHERE order is reversed on purpose; keys must follow PK order.
        await tx
          .delete(albums)
          .where(and(eq(albums.albumId, 'al1'), eq(albums.singerId, 's1')))
        await tx.delete(singers).where(eq(singers.id, 'a'))
      },
      { mode: 'bufferedMutations' }
    )
    expect(fake.mutations).toEqual([
      { kind: 'deleteRows', table: 'albums', payload: [['s1', 'al1']] },
      { kind: 'deleteRows', table: 'singers', payload: [['a']] }
    ])
  })

  it('throws typed errors on reads, $count, and returning', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)

    await expect(
      db.transaction(
        async (tx) => {
          // The mutation transaction type has no select; the session runner
          // is the runtime backstop for casts.
          await (tx as unknown as SpannerDatabase).select().from(singers)
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    await expect(
      db.transaction(
        async (tx) => {
          await (tx as unknown as SpannerDatabase).$count(singers)
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    await expect(
      db.transaction(
        async (tx) => {
          await tx.insert(singers).values({ id: 'a', name: 'Ada' }).returning()
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)

    expect(fake.commitCount()).toBe(0)
    expect(fake.rollbackCount()).toBe(3)
  })

  it('rolls back and skips commit when the callback throws', async () => {
    const fake = fakeMutationDatabase()
    const db = drizzle(fake.database)
    await expect(
      db.transaction(
        async (tx) => {
          await tx.insert(singers).values({ id: 'a', name: 'Ada' })
          throw new Error('boom')
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toThrow('boom')
    expect(fake.commitCount()).toBe(0)
    expect(fake.rollbackCount()).toBe(1)
  })
})
