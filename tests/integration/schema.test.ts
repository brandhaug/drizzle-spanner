import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm/sql/expressions'
import {
  bool,
  bytes,
  commitTimestamp,
  date,
  float32,
  float64,
  index,
  int64,
  interleaveInParent,
  json,
  numeric,
  primaryKey,
  spannerTable,
  string,
  timestamp
} from '../../src/index.js'
import type { EmulatorHarness } from './harness.js'
import { startEmulator } from './harness.js'

const everyType = spannerTable('every_type', {
  id: string('id', { length: 36 }).primaryKey(),
  text: string('text', { length: 'max' }),
  n: int64('n'),
  big: int64('big', { mode: 'bigint' }),
  f64: float64('f64'),
  f32: float32('f32'),
  num: numeric('num'),
  bin: bytes('bin', { length: 'max' }),
  flag: bool('flag'),
  day: date('day'),
  at: timestamp('at'),
  doc: json('doc'),
  tags: string('tags', { length: 'max' }).array(),
  nums: int64('nums').array()
})

const events = spannerTable('events', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
  createdAt: timestamp('created_at', { allowCommitTimestamp: true })
})

const singers = spannerTable('singers', {
  singerId: string('singer_id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull()
})

const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 })
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_title').on(t.title).nullFiltered()
  ]
)

let harness: EmulatorHarness

beforeAll(async () => {
  harness = await startEmulator([
    `CREATE TABLE every_type (
      id STRING(36) NOT NULL,
      text STRING(MAX),
      n INT64,
      big INT64,
      f64 FLOAT64,
      f32 FLOAT32,
      num NUMERIC,
      bin BYTES(MAX),
      flag BOOL,
      day DATE,
      \`at\` TIMESTAMP,
      doc JSON,
      tags ARRAY<STRING(MAX)>,
      nums ARRAY<INT64>
    ) PRIMARY KEY (id)`,
    `CREATE TABLE events (
      id STRING(36) NOT NULL,
      name STRING(MAX) NOT NULL,
      created_at TIMESTAMP OPTIONS (allow_commit_timestamp = true)
    ) PRIMARY KEY (id)`,
    `CREATE TABLE singers (
      singer_id STRING(36) NOT NULL,
      name STRING(MAX) NOT NULL
    ) PRIMARY KEY (singer_id)`,
    `CREATE TABLE albums (
      singer_id STRING(36) NOT NULL,
      album_id STRING(36) NOT NULL,
      title STRING(1024)
    ) PRIMARY KEY (singer_id, album_id),
      INTERLEAVE IN PARENT singers ON DELETE CASCADE`,
    `CREATE NULL_FILTERED INDEX idx_albums_title ON albums (title)`
  ])
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('column type round-trips', () => {
  it('round-trips every column type with values', async () => {
    const { db } = harness
    const row = {
      id: 'row-1',
      text: 'héllo world',
      n: 42,
      big: 9223372036854775807n,
      f64: 3.5,
      f32: 1.5,
      num: '3.141592653',
      bin: Buffer.from('binary-data'),
      flag: true,
      day: '2026-07-29',
      at: new Date('2026-07-29T10:00:00.000Z'),
      doc: { nested: { list: [1, 2, 3] }, ok: true },
      tags: ['a', 'b'],
      nums: [1, 2, 3]
    }
    await db.insert(everyType).values(row)
    const [selected] = await db
      .select()
      .from(everyType)
      .where(eq(everyType.id, 'row-1'))
    expect(selected!.text).toBe(row.text)
    expect(selected!.n).toBe(42)
    expect(selected!.big).toBe(9223372036854775807n)
    expect(selected!.f64).toBe(3.5)
    expect(selected!.f32).toBe(1.5)
    expect(selected!.num).toBe('3.141592653')
    expect(Buffer.from(selected!.bin!).toString()).toBe('binary-data')
    expect(selected!.flag).toBe(true)
    expect(selected!.day).toBe('2026-07-29')
    expect(selected!.at).toBeInstanceOf(Date)
    expect(selected!.at!.toISOString()).toBe('2026-07-29T10:00:00.000Z')
    expect(selected!.doc).toEqual(row.doc)
    expect(selected!.tags).toEqual(['a', 'b'])
    expect(selected!.nums).toEqual([1, 2, 3])
  })

  it('binds null for every nullable column (schema-derived type hints)', async () => {
    const { db } = harness
    await db.insert(everyType).values({
      id: 'row-nulls',
      text: null,
      n: null,
      big: null,
      f64: null,
      f32: null,
      num: null,
      bin: null,
      flag: null,
      day: null,
      at: null,
      doc: null,
      tags: null,
      nums: null
    })
    const [selected] = await db
      .select()
      .from(everyType)
      .where(eq(everyType.id, 'row-nulls'))
    expect(selected!.text).toBeNull()
    expect(selected!.n).toBeNull()
    expect(selected!.big).toBeNull()
    expect(selected!.f64).toBeNull()
    expect(selected!.f32).toBeNull()
    expect(selected!.num).toBeNull()
    expect(selected!.bin).toBeNull()
    expect(selected!.flag).toBeNull()
    expect(selected!.day).toBeNull()
    expect(selected!.at).toBeNull()
    expect(selected!.doc).toBeNull()
    expect(selected!.tags).toBeNull()
    expect(selected!.nums).toBeNull()

    // Null params also need hints in WHERE position.
    const byNull = await db
      .select()
      .from(everyType)
      .where(and(eq(everyType.id, 'row-nulls'), isNull(everyType.text)))
    expect(byNull).toHaveLength(1)
  })

  it('binds empty arrays (the untyped-empty-array sharp edge)', async () => {
    const { db } = harness
    await db.insert(everyType).values({ id: 'row-empty', tags: [], nums: [] })
    const [selected] = await db
      .select()
      .from(everyType)
      .where(eq(everyType.id, 'row-empty'))
    expect(selected!.tags).toEqual([])
    expect(selected!.nums).toEqual([])
  })
})

describe('commit timestamps', () => {
  it('writes the commitTimestamp() sentinel and reads a real timestamp after commit', async () => {
    const { db } = harness
    const before = Date.now()
    await db
      .insert(events)
      .values({ id: 'e1', name: 'signup', createdAt: commitTimestamp() })
    const [event] = await db.select().from(events).where(eq(events.id, 'e1'))
    expect(event!.createdAt).toBeInstanceOf(Date)
    // The commit timestamp is assigned by Spanner at commit time.
    expect(event!.createdAt!.getTime()).toBeGreaterThanOrEqual(before - 60_000)
    expect(event!.createdAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000)

    await db
      .update(events)
      .set({ createdAt: commitTimestamp() })
      .where(eq(events.id, 'e1'))
    const [updated] = await db.select().from(events).where(eq(events.id, 'e1'))
    expect(updated!.createdAt!.getTime()).toBeGreaterThanOrEqual(
      event!.createdAt!.getTime()
    )
  })
})

describe('composite primary keys and interleaving', () => {
  it('round-trips an interleaved child under a composite key', async () => {
    const { db } = harness
    await db.insert(singers).values({ singerId: 's1', name: 'Ada' })
    await db.insert(albums).values([
      { singerId: 's1', albumId: 'a1', title: 'First' },
      { singerId: 's1', albumId: 'a2', title: 'Second' }
    ])

    const rows = await db
      .select()
      .from(albums)
      .where(and(eq(albums.singerId, 's1'), eq(albums.albumId, 'a2')))
    expect(rows).toEqual([{ singerId: 's1', albumId: 'a2', title: 'Second' }])

    // Update through the composite key.
    await db
      .update(albums)
      .set({ title: 'Second (remastered)' })
      .where(and(eq(albums.singerId, 's1'), eq(albums.albumId, 'a2')))
    expect(await db.$count(albums)).toBe(2)

    // ON DELETE CASCADE: deleting the parent removes interleaved children.
    await db.delete(singers).where(eq(singers.singerId, 's1'))
    expect(await db.$count(albums)).toBe(0)
  })
})
