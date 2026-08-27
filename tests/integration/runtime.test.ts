import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm/sql/expressions'
import {
  commitTimestamp,
  int64,
  SpannerInvalidArgumentError,
  spannerTable,
  string,
  timestamp
} from '../../src/index.js'
import { type SpannerDatabase } from '../../src/index.js'
import { type EmulatorHarness } from './harness.js'
import { startEmulator } from './harness.js'

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
  plays: int64('plays'),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true })
})

let harness: EmulatorHarness

beforeAll(async () => {
  harness = await startEmulator([
    `CREATE TABLE singers (
      id STRING(36) NOT NULL,
      name STRING(MAX) NOT NULL,
      plays INT64,
      updated_at TIMESTAMP OPTIONS (allow_commit_timestamp=true)
    ) PRIMARY KEY (id)`
  ])
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('read-only transactions', () => {
  it('reads a consistent snapshot while writes land outside', async () => {
    const { db } = harness
    await db.insert(singers).values({ id: 'ro-1', name: 'Ada' })

    const roIds = inArray(singers.id, ['ro-1', 'ro-2'])
    const counts = await db.transaction(
      async (tx) => {
        const before = await tx.$count(singers, roIds)
        // A write outside the snapshot: read-only transactions take no locks,
        // so this commits while the snapshot stays pinned to its timestamp.
        await db.insert(singers).values({ id: 'ro-2', name: 'Grace' })
        const after = await tx.$count(singers, roIds)
        return { before, after }
      },
      { readOnly: true }
    )

    expect(counts.before).toBe(1)
    expect(counts.after).toBe(1)
    expect(await db.$count(singers, roIds)).toBe(2)
    await db.delete(singers).where(roIds)
  })

  it('supports a readTimestamp bound', async () => {
    const { db } = harness
    // Derive the bound from the emulator's own commit timestamp — the host
    // clock and the container clock are not aligned.
    // PENDING_COMMIT_TIMESTAMP() is unreadable until commit, so read the
    // committed row back instead of using THEN RETURN.
    await db
      .insert(singers)
      .values({ id: 'rt-1', name: 'Ada', updatedAt: commitTimestamp() })
    const [first] = await db.select().from(singers).where(eq(singers.id, 'rt-1'))
    // The decoded Date truncates the commit timestamp's nanoseconds, which
    // would place the bound just before the commit — read 1ms after it, and
    // give the second insert clear distance past that bound.
    const at = new Date(first!.updatedAt!.getTime() + 1)
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
    await db.insert(singers).values({ id: 'rt-2', name: 'Grace' })

    const seen = await db.transaction(
      async (tx) =>
        tx
          .select()
          .from(singers)
          .where(inArray(singers.id, ['rt-1', 'rt-2'])),
      { readOnly: true, staleness: { readTimestamp: at } }
    )
    expect(seen.map((row) => row.id)).toEqual(['rt-1'])

    await db.delete(singers).where(inArray(singers.id, ['rt-1', 'rt-2']))
  })

  it('throws a typed error on DML inside the snapshot', async () => {
    const { db } = harness
    await expect(
      db.transaction(
        async (tx) => {
          await (tx as unknown as SpannerDatabase)
            .insert(singers)
            .values({ id: 'x', name: 'y' })
        },
        { readOnly: true }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
  })
})

describe('single-use bounded reads (withStaleness)', () => {
  it('runs a strong bounded read', async () => {
    const { db } = harness
    await db.insert(singers).values({ id: 'su-1', name: 'Ada' })
    const rows = await db.select().from(singers).withStaleness({ strong: true })
    expect(rows.map((row) => row.id)).toContain('su-1')
    await db.delete(singers).where(eq(singers.id, 'su-1'))
  })

  it('runs a readTimestamp bounded read', async () => {
    const { db } = harness
    await db
      .insert(singers)
      .values({ id: 'su-2', name: 'Ada', updatedAt: commitTimestamp() })
    const [first] = await db.select().from(singers).where(eq(singers.id, 'su-2'))
    const at = new Date(first!.updatedAt!.getTime() + 1)
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
    await db.insert(singers).values({ id: 'su-3', name: 'Grace' })

    const rows = await db
      .select()
      .from(singers)
      .where(inArray(singers.id, ['su-2', 'su-3']))
      .withStaleness({ readTimestamp: at })
    expect(rows.map((row) => row.id)).toEqual(['su-2'])

    await db.delete(singers).where(inArray(singers.id, ['su-2', 'su-3']))
  })
})

describe('bufferedMutations transactions', () => {
  it('round-trips insert, update, and delete as mutations', async () => {
    const { db } = harness

    await db.transaction(
      async (tx) => {
        await tx.insert(singers).values({
          id: 'mut-1',
          name: 'Mutation',
          plays: 1,
          updatedAt: commitTimestamp()
        })
      },
      { mode: 'bufferedMutations' }
    )
    const inserted = await db.select().from(singers).where(eq(singers.id, 'mut-1'))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]!.plays).toBe(1)
    // The commit-timestamp sentinel resolved to the commit time.
    expect(inserted[0]!.updatedAt).toBeInstanceOf(Date)

    await db.transaction(
      async (tx) => {
        await tx.update(singers).set({ plays: 2 }).where(eq(singers.id, 'mut-1'))
      },
      { mode: 'bufferedMutations' }
    )
    const updated = await db.select().from(singers).where(eq(singers.id, 'mut-1'))
    expect(updated[0]!.plays).toBe(2)
    expect(updated[0]!.name).toBe('Mutation')

    await db.transaction(
      async (tx) => {
        await tx.delete(singers).where(eq(singers.id, 'mut-1'))
      },
      { mode: 'bufferedMutations' }
    )
    expect(await db.$count(singers, eq(singers.id, 'mut-1'))).toBe(0)
  })

  it('throws typed errors on reads and returning, discarding buffered writes', async () => {
    const { db } = harness

    await expect(
      db.transaction(
        async (tx) => {
          await tx.insert(singers).values({ id: 'mut-2', name: 'Ghost' })
          await (tx as unknown as SpannerDatabase).select().from(singers)
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
    // The failed transaction rolled back; the buffered insert never committed.
    expect(await db.$count(singers, eq(singers.id, 'mut-2'))).toBe(0)

    await expect(
      db.transaction(
        async (tx) => {
          await tx.insert(singers).values({ id: 'mut-3', name: 'Ghost' }).returning()
        },
        { mode: 'bufferedMutations' }
      )
    ).rejects.toBeInstanceOf(SpannerInvalidArgumentError)
    expect(await db.$count(singers, eq(singers.id, 'mut-3'))).toBe(0)
  })
})
