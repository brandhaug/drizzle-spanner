import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, gt } from 'drizzle-orm/sql/expressions';
import { sql } from 'drizzle-orm/sql';
import { int64, spannerTable, string, timestamp } from '../../src/index.js';
import type { EmulatorHarness } from './harness.js';
import { startEmulator } from './harness.js';

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  plays: int64('plays'),
  updatedAt: timestamp('updated_at'),
});

let harness: EmulatorHarness;

beforeAll(async () => {
  harness = await startEmulator([
    `CREATE TABLE singers (
      id STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),
      name STRING(MAX) NOT NULL,
      plays INT64,
      updated_at TIMESTAMP
    ) PRIMARY KEY (id)`,
  ]);
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
});

describe('CRUD round-trip (the spike scenarios)', () => {
  it('runs insert/select/update/delete with parameter binding and THEN RETURN', async () => {
    const { db } = harness;

    // Insert with .returning(): DEFAULT pk via GENERATE_UUID, THEN RETURN.
    const inserted = await db
      .insert(singers)
      .values({ name: 'Ada', plays: 42, updatedAt: new Date('2026-07-29T10:00:00Z') })
      .returning();
    expect(inserted).toHaveLength(1);
    const ada = inserted[0]!;
    expect(ada.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ada.name).toBe('Ada');
    expect(ada.plays).toBe(42);
    expect(ada.updatedAt).toBeInstanceOf(Date);
    expect(ada.updatedAt!.toISOString()).toBe('2026-07-29T10:00:00.000Z');

    // Select with where on string and int64 params.
    const byName = await db.select().from(singers).where(eq(singers.name, 'Ada'));
    expect(byName).toHaveLength(1);
    expect(byName[0]!.id).toBe(ada.id);
    const byPlays = await db.select().from(singers).where(gt(singers.plays, 40));
    expect(byPlays).toHaveLength(1);

    // Update with where + returning.
    const updated = await db
      .update(singers)
      .set({ plays: 43 })
      .where(eq(singers.id, ada.id))
      .returning({ plays: singers.plays });
    expect(updated).toEqual([{ plays: 43 }]);

    // $count and raw SQL escape hatch.
    expect(await db.$count(singers)).toBe(1);
    const raw = await db.execute(sql`select count(*) as c from ${singers}`);
    expect(Number((raw[0] as { c: unknown }).c)).toBe(1);

    // Delete with where.
    await db.delete(singers).where(eq(singers.id, ada.id));
    expect(await db.$count(singers)).toBe(0);
  });

  it('runs a read-write transaction atomically and reads its own writes', async () => {
    const { db } = harness;
    const result = await db.transaction(async (tx) => {
      const [grace] = await tx.insert(singers).values({ name: 'Grace', plays: 1 }).returning();
      const inTx = await tx.select().from(singers).where(eq(singers.id, grace!.id));
      await tx.update(singers).set({ plays: 100 }).where(eq(singers.id, grace!.id));
      return { graceId: grace!.id, sawOwnInsert: inTx.length === 1 };
    });
    expect(result.sawOwnInsert).toBe(true);
    const after = await db.select().from(singers).where(eq(singers.id, result.graceId));
    expect(after).toHaveLength(1);
    expect(after[0]!.plays).toBe(100);
    await db.delete(singers).where(eq(singers.id, result.graceId));
  });

  it('re-executes the transaction callback when the emulator aborts it', async () => {
    const { db } = harness;
    const [row] = await db.insert(singers).values({ name: 'Retry', plays: 0 }).returning();

    let attempts = 0;
    await db.transaction(async (tx) => {
      attempts += 1;
      // Take a read lock inside this transaction first.
      await tx.select().from(singers).where(eq(singers.id, row!.id));
      if (attempts === 1) {
        // A second read-write transaction on the same row: the emulator
        // serializes read-write transactions, so ours gets ABORTED and the
        // driver re-runs the callback.
        await db.update(singers).set({ plays: 7 }).where(eq(singers.id, row!.id));
      }
      await tx.update(singers).set({ plays: 50 }).where(eq(singers.id, row!.id));
    });

    expect(attempts).toBeGreaterThan(1);
    const final = await db.select().from(singers).where(eq(singers.id, row!.id));
    expect(final[0]!.plays).toBe(50);
    await db.delete(singers).where(eq(singers.id, row!.id));
  });

  it('propagates tx.rollback() and leaves no writes behind', async () => {
    const { db } = harness;
    const before = await db.$count(singers);
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(singers).values({ name: 'Ghost' });
        tx.rollback();
      }),
    ).rejects.toThrow(/[Rr]ollback/);
    expect(await db.$count(singers)).toBe(before);
  });
});
