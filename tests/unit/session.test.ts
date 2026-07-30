import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm/sql/expressions';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import {
  drizzle,
  GrpcStatus,
  int64,
  SpannerAbortedError,
  SpannerConstraintError,
  SpannerInvalidArgumentError,
  SpannerUnavailableError,
  spannerTable,
  string,
} from '../../src/index.js';
import type {
  SpannerDriverDatabase,
  SpannerDriverTransaction,
  SpannerSqlRequest,
} from '../../src/index.js';

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
  plays: int64('plays'),
});

interface RecordedCall {
  request: SpannerSqlRequest;
  via: 'run' | 'transaction';
}

/** Fake @google-cloud/spanner Database recording requests and serving canned rows. */
function fakeDatabase(rows: { name: string; value: unknown }[][] = []) {
  const calls: RecordedCall[] = [];
  let commits = 0;
  let rollbacks = 0;
  const transaction: SpannerDriverTransaction = {
    async run(request) {
      calls.push({ request, via: 'transaction' });
      return [rows];
    },
    async commit() {
      commits += 1;
      return undefined;
    },
    async rollback() {
      rollbacks += 1;
      return undefined;
    },
    insert() {},
    update() {},
    upsert() {},
    deleteRows() {},
  };
  const database: SpannerDriverDatabase = {
    async run(request) {
      calls.push({ request, via: 'run' });
      return [rows];
    },
    async runTransactionAsync<T>(
      optionsOrRunFn:
        | { timeout?: number }
        | ((tx: SpannerDriverTransaction) => Promise<T>),
      maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>,
    ): Promise<T> {
      const runFn = typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!;
      return runFn(transaction);
    },
    async getSnapshot(): Promise<never> {
      throw new Error('these fakes take no snapshots');
    },
  };
  return {
    database,
    calls,
    commitCount: () => commits,
    rollbackCount: () => rollbacks,
  };
}

describe('parameter conversion', () => {
  it('sends named @p params with schema-derived type hints, including nulls', async () => {
    const fake = fakeDatabase();
    const db = drizzle(fake.database);
    await db.select().from(singers).where(eq(singers.name, 'Ada')).execute();
    expect(fake.calls).toHaveLength(1);
    const { request, via } = fake.calls[0]!;
    expect(via).toBe('run');
    expect(request.params).toEqual({ p0: 'Ada' });
    expect(request.types).toEqual({ p0: 'string' });

    fake.calls.length = 0;
    await db.insert(singers).values({ id: 'x', name: 'Ada', plays: null });
    const insert = fake.calls[0]!;
    expect(insert.via).toBe('transaction');
    expect(insert.request.params).toEqual({ p0: 'x', p1: 'Ada', p2: null });
    expect(insert.request.types).toEqual({ p0: 'string', p1: 'string', p2: 'int64' });
  });

  it('expands array type hints into { type, child } driver hints', async () => {
    const tags = spannerTable('tags', {
      id: string('id', { length: 36 }).primaryKey(),
      values: string('values', { length: 'max' }).array(),
    });
    const fake = fakeDatabase();
    const db = drizzle(fake.database);
    await db.insert(tags).values({ id: 'x', values: [] });
    expect(fake.calls[0]!.request.types).toEqual({
      p0: 'string',
      p1: { type: 'array', child: 'string' },
    });
  });
});

describe('DML routing', () => {
  it('runs reads via database.run and DML inside runTransactionAsync with commit', async () => {
    const fake = fakeDatabase();
    const db = drizzle(fake.database);
    await db.select().from(singers);
    expect(fake.calls[0]!.via).toBe('run');
    await db.update(singers).set({ plays: 1 }).where(eq(singers.id, 'x'));
    expect(fake.calls[1]!.via).toBe('transaction');
    expect(fake.commitCount()).toBe(1);
  });
});

describe('db.transaction', () => {
  it('runs the callback on one driver transaction and commits once', async () => {
    const fake = fakeDatabase([
      [
        { name: 'id', value: 'x' },
        { name: 'name', value: 'Ada' },
        { name: 'plays', value: { value: '42' } },
      ],
    ]);
    const db = drizzle(fake.database);
    const result = await db.transaction(async (tx) => {
      const rows = await tx.select().from(singers);
      await tx.update(singers).set({ plays: 1 }).where(eq(singers.id, 'x'));
      return rows;
    });
    expect(result).toEqual([{ id: 'x', name: 'Ada', plays: 42 }]);
    expect(fake.calls.every((call) => call.via === 'transaction')).toBe(true);
    expect(fake.commitCount()).toBe(1);
  });

  it('lets ABORTED errors propagate for the driver retry loop', async () => {
    let attempts = 0;
    const fake = fakeDatabase();
    const database: SpannerDriverDatabase = {
      run: fake.database.run,
      // Simulates the driver's AsyncTransactionRunner: retry runFn on ABORTED.
      async runTransactionAsync<T>(
        optionsOrRunFn:
          | { timeout?: number }
          | ((tx: SpannerDriverTransaction) => Promise<T>),
        maybeRunFn?: (tx: SpannerDriverTransaction) => Promise<T>,
      ): Promise<T> {
        const runFn = typeof optionsOrRunFn === 'function' ? optionsOrRunFn : maybeRunFn!;
        for (;;) {
          try {
            return await runFn({
              async run(request) {
                attempts += 1;
                if (attempts === 1) {
                  throw Object.assign(new Error('Transaction aborted'), {
                    code: GrpcStatus.ABORTED,
                  });
                }
                void request;
                return [[]];
              },
              async commit() {
                return undefined;
              },
              async rollback() {
                return undefined;
              },
              insert() {},
              update() {},
              upsert() {},
              deleteRows() {},
            });
          } catch (error) {
            if ((error as { code?: number }).code === GrpcStatus.ABORTED) continue;
            throw error;
          }
        }
      },
      getSnapshot: fake.database.getSnapshot,
    };
    const db = drizzle(database);
    await db.transaction(async (tx) => {
      await tx.select().from(singers);
    });
    expect(attempts).toBe(2);
  });

  it('wraps a DeadlineError into SpannerAbortedError (retries exhausted)', async () => {
    const database: SpannerDriverDatabase = {
      async run() {
        return [[]];
      },
      async runTransactionAsync() {
        throw Object.assign(new Error('Deadline exceeded'), { name: 'DeadlineError' });
      },
      async getSnapshot(): Promise<never> {
        throw new Error('these fakes take no snapshots');
      },
    };
    const db = drizzle(database);
    await expect(db.transaction(async () => {})).rejects.toBeInstanceOf(SpannerAbortedError);
  });

  it('tx.rollback() rolls back the driver transaction and throws', async () => {
    const fake = fakeDatabase();
    const db = drizzle(fake.database);
    await expect(
      db.transaction(async (tx) => {
        tx.rollback();
      }),
    ).rejects.toBeInstanceOf(TransactionRollbackError);
    expect(fake.rollbackCount()).toBe(1);
    expect(fake.commitCount()).toBe(0);
  });
});

describe('error taxonomy', () => {
  function failingDatabase(error: unknown): SpannerDriverDatabase {
    return {
      async run() {
        throw error;
      },
      async runTransactionAsync() {
        throw error;
      },
      async getSnapshot(): Promise<never> {
        throw error;
      },
    };
  }

  it('wraps ALREADY_EXISTS into SpannerConstraintError with sql and param names', async () => {
    const db = drizzle(
      failingDatabase(
        Object.assign(new Error('Row [x] already exists'), { code: GrpcStatus.ALREADY_EXISTS }),
      ),
    );
    const failure = await db
      .select()
      .from(singers)
      .where(eq(singers.id, 'x'))
      .execute()
      .catch((e) => e);
    expect(failure).toBeInstanceOf(SpannerConstraintError);
    expect(failure.code).toBe(GrpcStatus.ALREADY_EXISTS);
    expect(failure.query.sql).toContain('select');
    expect(failure.query.paramNames).toEqual(['p0']);
  });

  it('wraps INVALID_ARGUMENT with the untyped-parameter hint', async () => {
    const db = drizzle(
      failingDatabase(
        Object.assign(new Error('Invalid value for parameter p0'), {
          code: GrpcStatus.INVALID_ARGUMENT,
        }),
      ),
    );
    const failure = await db
      .select()
      .from(singers)
      .execute()
      .catch((e) => e);
    expect(failure).toBeInstanceOf(SpannerInvalidArgumentError);
    expect(failure.message).toContain('type hint');
  });

  it('INVALID_ARGUMENT hint names the column the failing parameter binds', async () => {
    const db = drizzle(
      failingDatabase(
        Object.assign(new Error('Invalid value for parameter p0'), {
          code: GrpcStatus.INVALID_ARGUMENT,
        }),
      ),
    );
    const failure = await db
      .select()
      .from(singers)
      .where(eq(singers.plays, 1))
      .execute()
      .catch((e) => e);
    expect(failure).toBeInstanceOf(SpannerInvalidArgumentError);
    expect(failure.message).toContain('parameter @p0 binds column "plays"');
  });

  it.each([
    ['UNAVAILABLE', GrpcStatus.UNAVAILABLE],
    ['DEADLINE_EXCEEDED', GrpcStatus.DEADLINE_EXCEEDED],
  ])('wraps %s into SpannerUnavailableError', async (_name, code) => {
    const db = drizzle(
      failingDatabase(Object.assign(new Error('transport failure'), { code })),
    );
    const failure = await db
      .select()
      .from(singers)
      .execute()
      .catch((e) => e);
    expect(failure).toBeInstanceOf(SpannerUnavailableError);
    expect(failure.kind).toBe('unavailable');
    expect(failure.code).toBe(code);
  });

  // Spec (error handling): errors carry the SQL with parameter names, never
  // parameter values. Nothing reachable on any wrapped variant may leak the
  // bound value.
  it.each([
    ['ABORTED', GrpcStatus.ABORTED],
    ['ALREADY_EXISTS', GrpcStatus.ALREADY_EXISTS],
    ['FAILED_PRECONDITION', GrpcStatus.FAILED_PRECONDITION],
    ['INVALID_ARGUMENT', GrpcStatus.INVALID_ARGUMENT],
    ['UNAVAILABLE', GrpcStatus.UNAVAILABLE],
    ['DEADLINE_EXCEEDED', GrpcStatus.DEADLINE_EXCEEDED],
  ])('never exposes parameter values on a wrapped %s failure', async (_name, code) => {
    const secret = 'PARAM-VALUE-a2c5e7';
    const db = drizzle(
      failingDatabase(Object.assign(new Error('driver failure'), { code })),
    );
    const failure = await db
      .insert(singers)
      .values({ id: secret, name: secret })
      .execute()
      .catch((e) => e);
    expect(failure.message).not.toContain(secret);
    expect(failure.query.sql).not.toContain(secret);
    expect(JSON.stringify({ ...failure, stack: undefined })).not.toContain(secret);
  });
});
