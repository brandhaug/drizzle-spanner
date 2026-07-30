import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm/sql';
import {
  drizzle,
  GrpcStatus,
  SpannerAbortedError,
  SpannerInvalidArgumentError,
  spannerTable,
  string,
} from '../../src/index.js';
import type {
  SpannerDriverDatabase,
  SpannerDriverRow,
  SpannerDriverTransaction,
  SpannerSqlRequest,
} from '../../src/index.js';

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
});

function abortedError(): Error & { code: number } {
  return Object.assign(new Error('Transaction aborted'), { code: GrpcStatus.ABORTED });
}

/**
 * Fake @google-cloud/spanner Database whose runTransactionAsync mimics the
 * driver's retry loop: the callback re-runs while it throws ABORTED, up to a
 * cap standing in for the driver's deadline.
 */
function fakeRetryingDatabase(retryCap = 25) {
  const recordedOptions: unknown[] = [];
  let attempts = 0;
  const transaction: SpannerDriverTransaction = {
    async run(request: SpannerSqlRequest) {
      void request;
      return [[]];
    },
    async commit() {
      return undefined;
    },
    async rollback() {
      return undefined;
    },
  };
  const database = {
    async run() {
      return [[]];
    },
    async runTransactionAsync<T>(
      optionsOrRunFn:
        | { timeout?: number }
        | ((tx: SpannerDriverTransaction) => Promise<T>),
      maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>,
    ): Promise<T> {
      const runFn = typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!;
      recordedOptions.push(typeof optionsOrRunFn === 'function' ? undefined : optionsOrRunFn);
      for (let i = 0; i < retryCap; i++) {
        attempts += 1;
        try {
          return await runFn(transaction);
        } catch (error) {
          if ((error as { code?: unknown }).code === GrpcStatus.ABORTED) continue;
          throw error;
        }
      }
      throw Object.assign(new Error('Deadline for Transaction exceeded.'), {
        name: 'DeadlineError',
      });
    },
    async getSnapshot(): Promise<never> {
      throw new Error('read-write fakes take no snapshots');
    },
  } satisfies SpannerDriverDatabase & Record<string, unknown>;
  return {
    database: database as SpannerDriverDatabase,
    recordedOptions,
    attemptCount: () => attempts,
  };
}

/** Fake database whose getSnapshot records bounds and serves a read-only snapshot. */
function fakeSnapshotDatabase(rows: { name: string; value: unknown }[][] = []) {
  const snapshotBounds: unknown[] = [];
  const snapshotRequests: SpannerSqlRequest[] = [];
  let ended = 0;
  const database = {
    async run() {
      return [[]] as [SpannerDriverRow[]];
    },
    async runTransactionAsync<T>(
      optionsOrRunFn:
        | { timeout?: number }
        | ((tx: SpannerDriverTransaction) => Promise<T>),
      maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>,
    ): Promise<T> {
      void optionsOrRunFn;
      void maybeRunFn;
      throw new Error('read-only transactions must not open a read-write transaction');
    },
    async getSnapshot(bounds?: unknown) {
      snapshotBounds.push(bounds);
      return [
        {
          async run(request: SpannerSqlRequest) {
            snapshotRequests.push(request);
            return [rows] as [SpannerDriverRow[]];
          },
          end() {
            ended += 1;
          },
        },
      ] as const;
    },
  };
  return {
    database: database as unknown as SpannerDriverDatabase,
    snapshotBounds,
    snapshotRequests,
    endCount: () => ended,
  };
}

describe('transaction options', () => {
  it('threads timeout into runTransactionAsync options', async () => {
    const fake = fakeRetryingDatabase();
    const db = drizzle(fake.database);
    await db.transaction(async () => 'ok', { timeout: 5000 });
    expect(fake.recordedOptions).toEqual([{ timeout: 5000 }]);
  });

  it('passes no options object when none are given', async () => {
    const fake = fakeRetryingDatabase();
    const db = drizzle(fake.database);
    await db.transaction(async () => 'ok');
    expect(fake.recordedOptions).toEqual([undefined]);
  });

  it('keeps transparent ABORTED retries and resolves on a later attempt', async () => {
    const fake = fakeRetryingDatabase();
    const db = drizzle(fake.database);
    let calls = 0;
    const result = await db.transaction(async (tx) => {
      calls += 1;
      if (calls < 3) throw abortedError();
      const rows = await tx.select().from(singers);
      void rows;
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws SpannerAbortedError once maxRetries is exhausted', async () => {
    const fake = fakeRetryingDatabase();
    const db = drizzle(fake.database);
    let calls = 0;
    await expect(
      db.transaction(
        async () => {
          calls += 1;
          throw abortedError();
        },
        { maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(SpannerAbortedError);
    // maxRetries = 2 means one initial attempt plus two retries.
    expect(calls).toBe(3);
  });
});

describe('read-only transactions', () => {
  it('runs queries on a snapshot and ends it afterwards', async () => {
    const fake = fakeSnapshotDatabase([
      [
        { name: 'id', value: 'x' },
        { name: 'name', value: 'Ada' },
      ],
    ]);
    const db = drizzle(fake.database);
    const result = await db.transaction(
      async (tx) => tx.select().from(singers),
      { readOnly: true },
    );
    expect(result).toEqual([{ id: 'x', name: 'Ada' }]);
    expect(fake.snapshotBounds).toEqual([undefined]);
    expect(fake.snapshotRequests).toHaveLength(1);
    expect(fake.endCount()).toBe(1);
  });

  it('ends the snapshot when the callback throws', async () => {
    const fake = fakeSnapshotDatabase();
    const db = drizzle(fake.database);
    await expect(
      db.transaction(
        async () => {
          throw new Error('boom');
        },
        { readOnly: true },
      ),
    ).rejects.toThrow('boom');
    expect(fake.endCount()).toBe(1);
  });

  it('encodes staleness bounds into driver timestamp bounds', async () => {
    const fake = fakeSnapshotDatabase();
    const db = drizzle(fake.database);
    const readAt = new Date('2026-07-30T10:00:00.250Z');

    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { strong: true },
    });
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { exactStaleness: '15s' },
    });
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { exactStaleness: 500 },
    });
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { readTimestamp: readAt },
    });
    await db.transaction(async () => undefined, {
      readOnly: true,
      staleness: { minReadTimestamp: '2026-07-30T10:00:00Z' },
    });

    expect(fake.snapshotBounds).toEqual([
      { strong: true },
      // The driver's numeric convenience form for staleness is milliseconds.
      { exactStaleness: 15_000 },
      { exactStaleness: 500 },
      // Timestamps encode to protobuf form; a plain Date would be misread.
      { readTimestamp: { seconds: 1_785_405_600, nanos: 250_000_000 } },
      { minReadTimestamp: { seconds: 1_785_405_600, nanos: 0 } },
    ]);
  });

  it('rejects an unparseable staleness duration with a typed error', async () => {
    const fake = fakeSnapshotDatabase();
    const db = drizzle(fake.database);
    await expect(
      db.transaction(async () => undefined, {
        readOnly: true,
        staleness: { exactStaleness: 'fifteen seconds' },
      }),
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError);
  });

  it('exposes only read methods at the type level and throws typed on DML at runtime', async () => {
    const fake = fakeSnapshotDatabase();
    const db = drizzle(fake.database);
    await expect(
      db.transaction(
        async (tx) => {
          // @ts-expect-error — the read-only transaction type has no insert
          void tx.insert;
          // The runtime backstop: raw DML through the session runner.
          await tx.execute(sql`update singers set name = 'x' where true`);
        },
        { readOnly: true },
      ),
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError);
    expect(fake.endCount()).toBe(1);
  });
});

describe('single-use stale reads (withStaleness)', () => {
  function fakeBoundedReadDatabase(rows: { name: string; value: unknown }[][] = []) {
    const runBounds: unknown[] = [];
    const database = {
      async run(request: SpannerSqlRequest, bounds?: unknown) {
        void request;
        runBounds.push(bounds);
        return [rows] as [SpannerDriverRow[]];
      },
      async runTransactionAsync<T>(
        optionsOrRunFn:
          | { timeout?: number }
          | ((tx: SpannerDriverTransaction) => Promise<T>),
        maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>,
      ): Promise<T> {
        const runFn = typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!;
        return runFn({
          async run() {
            return [rows] as [SpannerDriverRow[]];
          },
          async commit() {
            return undefined;
          },
          async rollback() {
            return undefined;
          },
        });
      },
      async getSnapshot() {
        return [
          {
            async run() {
              return [rows] as [SpannerDriverRow[]];
            },
            end() {},
          },
        ] as const;
      },
    };
    return { database: database as unknown as SpannerDriverDatabase, runBounds };
  }

  it('compiles to a single-use bounded read on database.run', async () => {
    const fake = fakeBoundedReadDatabase([
      [
        { name: 'id', value: 'x' },
        { name: 'name', value: 'Ada' },
      ],
    ]);
    const db = drizzle(fake.database);
    const rows = await db.select().from(singers).withStaleness({ exactStaleness: '15s' });
    expect(rows).toEqual([{ id: 'x', name: 'Ada' }]);
    expect(fake.runBounds).toEqual([{ exactStaleness: 15_000 }]);
  });

  it('leaves ordinary reads unbounded', async () => {
    const fake = fakeBoundedReadDatabase();
    const db = drizzle(fake.database);
    await db.select().from(singers);
    expect(fake.runBounds).toEqual([undefined]);
  });

  it('chains with where/orderBy/limit', async () => {
    const fake = fakeBoundedReadDatabase();
    const db = drizzle(fake.database);
    await db
      .select()
      .from(singers)
      .where(sql`true`)
      .orderBy(singers.name)
      .limit(5)
      .withStaleness({ strong: true });
    expect(fake.runBounds).toEqual([{ strong: true }]);
  });

  it('is omitted from the transaction-scoped select type and throws typed at runtime', async () => {
    const fake = fakeBoundedReadDatabase();
    const db = drizzle(fake.database);
    await expect(
      db.transaction(async (tx) => {
        const select = tx.select().from(singers);
        // @ts-expect-error — withStaleness is not on the transaction-scoped select
        await select.withStaleness({ strong: true });
      }),
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError);

    await expect(
      db.transaction(
        async (tx) => {
          const select = tx.select().from(singers);
          // @ts-expect-error — withStaleness is not on the read-only select either
          await select.withStaleness({ strong: true });
        },
        { readOnly: true },
      ),
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError);
  });
});
