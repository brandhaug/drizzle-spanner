import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { eq, isNotNull } from 'drizzle-orm/sql/expressions'
import { sql } from 'drizzle-orm/sql'
import { bool, inUnnest, spannerTable, string, timestamp } from '../../src/index.js'
import { type EmulatorHarness } from './harness.js'
import { rejectionOf } from '../rejection.js'
import { startEmulator } from './harness.js'

const current = spannerTable('current_entities', {
  id: string('id', { length: 'max' }).primaryKey(),
  isStale: bool('is_stale'),
  syncedAt: timestamp('synced_at')
})

const legacy = spannerTable('legacy_entities', {
  id: string('id', { length: 'max' }).primaryKey(),
  isStale: bool('is_stale'),
  syncedAt: timestamp('synced_at')
})

const runs = spannerTable('runs', {
  id: string('id', { length: 36 }).primaryKey(),
  source: string('source', { length: 'max' }).notNull(),
  verifiedAt: timestamp('verified_at').notNull(),
  publishedAt: timestamp('published_at')
})

let harness: EmulatorHarness

beforeAll(async () => {
  const table = (name: string) => `CREATE TABLE ${name} (
      id STRING(MAX) NOT NULL,
      is_stale BOOL,
      synced_at TIMESTAMP
    ) PRIMARY KEY (id)`
  harness = await startEmulator([
    table('current_entities'),
    table('legacy_entities'),
    `CREATE TABLE runs (
      id STRING(36) NOT NULL,
      source STRING(MAX) NOT NULL,
      verified_at TIMESTAMP NOT NULL,
      published_at TIMESTAMP
    ) PRIMARY KEY (id)`
  ])
  const { db } = harness
  await db.insert(current).values([
    { id: 'E1', isStale: true, syncedAt: new Date('2026-11-01T00:00:00Z') },
    { id: 'E2', isStale: false, syncedAt: new Date('2026-11-02T00:00:00Z') }
  ])
  await db.insert(legacy).values([
    { id: 'E1', isStale: false, syncedAt: new Date('2026-10-01T00:00:00Z') },
    { id: 'E3', isStale: null, syncedAt: null }
  ])
  await db.insert(runs).values([
    {
      id: 'r1',
      source: 'brreg',
      verifiedAt: new Date('2026-11-01T00:00:00Z'),
      publishedAt: new Date('2026-11-01T01:00:00Z')
    },
    {
      id: 'r2',
      source: 'brreg',
      verifiedAt: new Date('2026-11-03T00:00:00Z'),
      publishedAt: new Date('2026-11-03T01:00:00Z')
    },
    {
      id: 'r3',
      source: 'brreg',
      verifiedAt: new Date('2026-11-05T00:00:00Z'),
      publishedAt: null
    },
    {
      id: 'r4',
      source: 'prh',
      verifiedAt: new Date('2026-11-02T00:00:00Z'),
      publishedAt: new Date('2026-11-02T01:00:00Z')
    }
  ])
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('select composition on Spanner', () => {
  const copies = (
    table: typeof current | typeof legacy,
    rank: number,
    ids: Array<string>
  ) =>
    harness.db
      .select({
        id: table.id,
        isStale: table.isStale,
        syncedAt: table.syncedAt,
        rank: sql<number>`${sql.raw(String(rank))}`.mapWith(Number).as('rank')
      })
      .from(table)
      .where(inUnnest(table.id, ids))

  it('orders every copy of the requested ids across a UNION ALL', async () => {
    const ids = ['E1', 'E2', 'E3', 'missing']
    const rows = await copies(current, 0, ids)
      .unionAll(copies(legacy, 1, ids))
      .orderBy(current.id, sql`rank`, sql`ifnull(is_stale, false)`, sql`synced_at desc`)
    expect(rows.map((row) => [row.id, row.rank, row.isStale])).toEqual([
      ['E1', 0, true],
      ['E1', 1, false],
      ['E2', 0, false],
      ['E3', 1, null]
    ])
    expect(rows[0]!.syncedAt).toEqual(new Date('2026-11-01T00:00:00Z'))
  })

  it('runs a chain that mixes set operators', async () => {
    const idsIn = (table: typeof current | typeof legacy, ids: Array<string>) =>
      harness.db.select({ id: table.id }).from(table).where(inUnnest(table.id, ids))
    const rows = await idsIn(current, ['E1', 'E2'])
      .unionAll(idsIn(legacy, ['E1', 'E3']))
      .except(idsIn(legacy, ['E1']))
      .orderBy(current.id)
    expect(rows).toEqual([{ id: 'E2' }, { id: 'E3' }])
  })

  it('reads nothing for an empty inUnnest list', async () => {
    expect(await copies(current, 0, [])).toEqual([])
  })

  it('groups with an aggregate and reads it through a subquery', async () => {
    const latest = harness.db
      .select({
        source: runs.source,
        verifiedAt: sql<Date>`max(${runs.verifiedAt})`
          .mapWith(runs.verifiedAt)
          .as('verified_at')
      })
      .from(runs)
      .where(isNotNull(runs.publishedAt))
      .groupBy(runs.source)
      .as('latest')
    const rows = await harness.db.select().from(latest).orderBy(latest.source)
    expect(rows).toEqual([
      { source: 'brreg', verifiedAt: new Date('2026-11-03T00:00:00Z') },
      { source: 'prh', verifiedAt: new Date('2026-11-02T00:00:00Z') }
    ])
  })

  it('sends request options Spanner accepts', async () => {
    const rows = await harness.db
      .select({ id: current.id })
      .from(current)
      .where(eq(current.id, 'E2'))
      .withRequestOptions({ requestTag: 'drizzle_spanner_test', priority: 'low' })
    expect(rows).toEqual([{ id: 'E2' }])
  })

  it('reads through a cancellable stream, and an aborted read rejects', async () => {
    const read = (signal: AbortSignal) =>
      harness.db
        .select({ id: current.id })
        .from(current)
        .orderBy(current.id)
        .withSignal(signal)
    expect(await read(new AbortController().signal)).toEqual([
      { id: 'E1' },
      { id: 'E2' }
    ])
    const controller = new AbortController()
    const pending = read(controller.signal).execute()
    const reason = new Error('caller gave up')
    controller.abort(reason)
    expect(await rejectionOf(pending)).toBe(reason)
  })

  it('reads single-use when cancellable: no read-only transaction, and single-use bounds apply', async () => {
    const getSnapshot = spyOn(harness.database, 'getSnapshot')
    try {
      const rows = await harness.db
        .select({ id: current.id })
        .from(current)
        .orderBy(current.id)
        .withStaleness({ maxStaleness: '10s' })
        .withSignal(new AbortController().signal)
      expect(rows).toEqual([{ id: 'E1' }, { id: 'E2' }])
      expect(getSnapshot).not.toHaveBeenCalled()
    } finally {
      getSnapshot.mockRestore()
    }
  })
})
