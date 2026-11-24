import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { count, sql } from 'drizzle-orm/sql'
import { and, asc, eq, isNull } from 'drizzle-orm/sql/expressions'
import { int64, spannerTable, string } from '../../src/index.js'
import { type EmulatorHarness } from './harness.js'
import { startEmulator } from './harness.js'
import { type Equal } from '../type-equal.js'

const artists = spannerTable('artists', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull()
})

const records = spannerTable('records', {
  id: string('id', { length: 36 }).primaryKey(),
  artistId: string('artist_id', { length: 36 }),
  title: string('title', { length: 'max' }).notNull(),
  year: int64('year')
})

type Artist = { id: string; name: string }
type Record_ = {
  id: string
  artistId: string | null
  title: string
  year: number | null
}

let harness: EmulatorHarness

beforeAll(async () => {
  harness = await startEmulator([
    `CREATE TABLE artists (
      id STRING(36) NOT NULL,
      name STRING(MAX) NOT NULL
    ) PRIMARY KEY (id)`,
    `CREATE TABLE records (
      id STRING(36) NOT NULL,
      artist_id STRING(36),
      title STRING(MAX) NOT NULL,
      year INT64
    ) PRIMARY KEY (id)`
  ])
  await harness.db.insert(artists).values([
    { id: 'a1', name: 'Ada' },
    { id: 'a2', name: 'Grace' }
  ])
  await harness.db.insert(records).values([
    { id: 'r1', artistId: 'a1', title: 'First', year: 2001 },
    { id: 'r2', artistId: 'a1', title: 'Second', year: null },
    { id: 'r3', artistId: null, title: 'Orphan', year: 1999 }
  ])
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

const ada: Artist = { id: 'a1', name: 'Ada' }
const grace: Artist = { id: 'a2', name: 'Grace' }
const first: Record_ = { id: 'r1', artistId: 'a1', title: 'First', year: 2001 }
const second: Record_ = { id: 'r2', artistId: 'a1', title: 'Second', year: null }
const orphan: Record_ = { id: 'r3', artistId: null, title: 'Orphan', year: 1999 }

describe('joins on Spanner', () => {
  it('inner join returns each table as a non-null object', async () => {
    const rows = await harness.db
      .select()
      .from(artists)
      .innerJoin(records, eq(records.artistId, artists.id))
      .orderBy(records.id)
    const types: Equal<typeof rows, Array<{ artists: Artist; records: Record_ }>> = true
    void types
    expect(rows).toEqual([
      { artists: ada, records: first },
      { artists: ada, records: second }
    ])
  })

  it('left join returns null for a joined table with no matching row', async () => {
    const rows = await harness.db
      .select()
      .from(artists)
      .leftJoin(records, eq(records.artistId, artists.id))
      .orderBy(artists.id, records.id)
    const types: Equal<
      typeof rows,
      Array<{ artists: Artist; records: Record_ | null }>
    > = true
    void types
    expect(rows).toEqual([
      { artists: ada, records: first },
      { artists: ada, records: second },
      { artists: grace, records: null }
    ])
  })

  it('right join makes the tables joined before it nullable', async () => {
    const rows = await harness.db
      .select()
      .from(artists)
      .rightJoin(records, eq(records.artistId, artists.id))
      .orderBy(records.id)
    const types: Equal<
      typeof rows,
      Array<{ artists: Artist | null; records: Record_ }>
    > = true
    void types
    expect(rows).toEqual([
      { artists: ada, records: first },
      { artists: ada, records: second },
      { artists: null, records: orphan }
    ])
  })

  it('full join makes every table nullable', async () => {
    const rows = await harness.db
      .select()
      .from(artists)
      .fullJoin(records, eq(records.artistId, artists.id))
      .orderBy(artists.id, records.id)
    const types: Equal<
      typeof rows,
      Array<{ artists: Artist | null; records: Record_ | null }>
    > = true
    void types
    expect(rows).toEqual([
      { artists: null, records: orphan },
      { artists: ada, records: first },
      { artists: ada, records: second },
      { artists: grace, records: null }
    ])
  })

  it('cross join pairs every row of both tables', async () => {
    const rows = await harness.db
      .select({ artist: artists.id, record: records.id })
      .from(artists)
      .crossJoin(records)
      .orderBy(artists.id, records.id)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ artist: 'a1', record: 'r1' })
  })

  it('types fields of a nullable table as nullable in a partial select', async () => {
    const rows = await harness.db
      .select({ name: artists.name, title: records.title })
      .from(artists)
      .leftJoin(records, eq(records.artistId, artists.id))
      .orderBy(artists.id, records.id)
    const types: Equal<
      typeof rows,
      Array<{ name: string; title: string | null }>
    > = true
    void types
    expect(rows).toEqual([
      { name: 'Ada', title: 'First' },
      { name: 'Ada', title: 'Second' },
      { name: 'Grace', title: null }
    ])
  })

  it('joins a subquery by its alias', async () => {
    const counts = harness.db
      .select({ artistId: records.artistId, total: count().as('total') })
      .from(records)
      .groupBy(records.artistId)
      .as('counts')
    const rows = await harness.db
      .select({
        name: artists.name,
        total: counts.total,
        countedArtist: counts.artistId
      })
      .from(artists)
      .leftJoin(counts, eq(counts.artistId, artists.id))
      .orderBy(asc(artists.id))
    const types: Equal<
      typeof rows,
      Array<{ name: string; total: number | null; countedArtist: string | null }>
    > = true
    void types
    expect(rows).toEqual([
      { name: 'Ada', total: 2, countedArtist: 'a1' },
      { name: 'Grace', total: null, countedArtist: null }
    ])
  })

  it('reads a left-joined subquery with no matching row as null in whole rows', async () => {
    const titles = harness.db
      .select({ artistId: records.artistId, title: records.title })
      .from(records)
      .where(eq(records.id, 'r1'))
      .as('titles')
    const rows = await harness.db
      .select()
      .from(artists)
      .leftJoin(titles, eq(titles.artistId, artists.id))
      .orderBy(artists.id)
    const types: Equal<
      typeof rows,
      Array<{
        artists: Artist
        titles: { artistId: string | null; title: string } | null
      }>
    > = true
    void types
    expect(rows).toEqual([
      { artists: ada, titles: { artistId: 'a1', title: 'First' } },
      { artists: grace, titles: null }
    ])
  })

  it('keeps SQL fields of a partial select typed after a join', async () => {
    const rows = await harness.db
      .select({
        name: artists.name,
        records: sql<number>`count(${records.id})`.mapWith(Number),
        latest: sql<number>`coalesce(max(${records.year}), 0)`
          .mapWith(Number)
          .as('latest')
      })
      .from(artists)
      .leftJoin(records, eq(records.artistId, artists.id))
      .groupBy(artists.name)
      .orderBy(artists.name)
    const types: Equal<
      typeof rows,
      Array<{ name: string; records: number; latest: number }>
    > = true
    void types
    expect(rows).toEqual([
      { name: 'Ada', records: 2, latest: 2001 },
      { name: 'Grace', records: 0, latest: 0 }
    ])
  })

  it('takes the join condition as a callback over the joined fields', async () => {
    const rows = await harness.db
      .select()
      .from(artists)
      .innerJoin(records, (fields) => eq(fields.records.artistId, fields.artists.id))
      .where(eq(records.id, 'r2'))
    expect(rows).toEqual([{ artists: ada, records: second }])
  })

  it('reads a nullable joined table as null through a set operator', async () => {
    const unmatched = (id: string) =>
      harness.db
        .select()
        .from(artists)
        .leftJoin(records, eq(records.artistId, artists.id))
        .where(eq(artists.id, id))
    const rows = await unmatched('a2').unionAll(unmatched('a2'))
    expect(rows).toEqual([
      { artists: grace, records: null },
      { artists: grace, records: null }
    ])
  })

  it('keeps join nullability in a subquery made from a joined select', async () => {
    const titled = harness.db
      .select({ name: artists.name, title: records.title })
      .from(artists)
      .leftJoin(records, eq(records.artistId, artists.id))
      .as('titled')
    const rows = await harness.db
      .select()
      .from(titled)
      .orderBy(titled.name, titled.title)
    const types: Equal<
      typeof rows,
      Array<{ name: string; title: string | null }>
    > = true
    void types
    expect(rows).toEqual([
      { name: 'Ada', title: 'First' },
      { name: 'Ada', title: 'Second' },
      { name: 'Grace', title: null }
    ])
  })

  it('nests subqueries, keeping the inner join nullability', async () => {
    const titled = harness.db
      .select({ name: artists.name, title: records.title })
      .from(artists)
      .leftJoin(records, eq(records.artistId, artists.id))
      .as('titled')
    const untitled = harness.db
      .select({ name: titled.name, title: titled.title })
      .from(titled)
      .where(isNull(titled.title))
      .as('untitled')
    const rows = await harness.db.select().from(untitled)
    const types: Equal<
      typeof rows,
      Array<{ name: string; title: string | null }>
    > = true
    void types
    expect(rows).toEqual([{ name: 'Grace', title: null }])
  })

  it('reads a left-joined subquery of only SQL fields as null when it has no row', async () => {
    const counts = harness.db
      .select({ total: count().as('total') })
      .from(records)
      .where(eq(records.id, 'none'))
      .having(sql`count(*) > 0`)
      .as('counts')
    const rows = await harness.db
      .select()
      .from(artists)
      .leftJoin(counts, sql`true`)
      .where(eq(artists.id, 'a1'))
    expect(rows).toEqual([{ artists: ada, counts: null }])
  })

  it('qualifies subquery fields in a callback join condition', async () => {
    const counts = harness.db
      .select({ id: records.artistId, total: count().as('total') })
      .from(records)
      .groupBy(records.artistId)
      .as('counts')
    // Both sides have an `id`: unqualified, Spanner would reject it as ambiguous.
    const joined = harness.db
      .select()
      .from(artists)
      .innerJoin(counts, (fields) =>
        and(eq(fields.counts.id, fields.artists.id), eq(fields.counts.total, 2))
      )
    expect(joined.toSQL().sql).toContain(
      'on ((`counts`.`artist_id` = `artists`.`id`) and (`counts`.`total` = @p0))'
    )
    expect(await joined).toEqual([{ artists: ada, counts: { id: 'a1', total: 2 } }])
  })

  it('refuses a subquery of whole rows from joined tables, whose columns would repeat', () => {
    expect(() =>
      harness.db
        .select()
        .from(artists)
        .innerJoin(records, eq(records.artistId, artists.id))
        .as('both')
    ).toThrow('name the fields')
  })

  it('runs a joined read with request options and a signal', async () => {
    const rows = await harness.db
      .select({ name: artists.name, title: records.title })
      .from(artists)
      .innerJoin(records, eq(records.artistId, artists.id))
      .where(eq(records.id, 'r1'))
      .withRequestOptions({ requestTag: 'joined_read' })
      .withSignal(new AbortController().signal)
    expect(rows).toEqual([{ name: 'Ada', title: 'First' }])
  })

  it('joins inside a transaction', async () => {
    const rows = await harness.db.transaction(
      async (tx) =>
        tx
          .select()
          .from(records)
          .leftJoin(artists, eq(artists.id, records.artistId))
          .where(eq(records.id, 'r3')),
      { readOnly: true }
    )
    const types: Equal<
      typeof rows,
      Array<{ records: Record_; artists: Artist | null }>
    > = true
    void types
    expect(rows).toEqual([{ records: orphan, artists: null }])
  })

  it('refuses to join a table twice under one name', () => {
    expect(() =>
      harness.db
        .select()
        .from(artists)
        .innerJoin(records, eq(records.artistId, artists.id))
        .innerJoin(records, eq(records.artistId, artists.id))
    ).toThrow('"records" is already used in this query')
  })
})
