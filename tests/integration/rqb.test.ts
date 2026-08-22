import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { defineRelations } from 'drizzle-orm/relations'
import {
  drizzle,
  int64,
  interleaveInParent,
  primaryKey,
  spannerTable,
  string
} from '../../src/index.js'
import type { EmulatorHarness } from './harness.js'
import { startEmulator } from './harness.js'

// Spanner interleaving requires the child key columns to carry the parent
// key's names, so the parent key is singer_id everywhere.
const singers = spannerTable('singers', {
  singerId: string('singer_id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull()
})

const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 }),
    plays: int64('plays')
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' })
  ]
)

const tracks = spannerTable(
  'tracks',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    trackId: string('track_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 })
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId, t.trackId] }),
    interleaveInParent(albums, { onDelete: 'cascade' })
  ]
)

const relations = defineRelations({ singers, albums, tracks }, (r) => ({
  singers: {
    albums: r.many.albums()
  },
  albums: {
    singer: r.one.singers({ from: r.albums.singerId, to: r.singers.singerId }),
    tracks: r.many.tracks()
  },
  tracks: {
    album: r.one.albums({
      from: [r.tracks.singerId, r.tracks.albumId],
      to: [r.albums.singerId, r.albums.albumId]
    })
  }
}))

let harness: EmulatorHarness
let db: ReturnType<typeof makeDb>

function makeDb(client: Parameters<typeof drizzle>[0]) {
  return drizzle(client, { relations })
}

beforeAll(async () => {
  harness = await startEmulator([
    `CREATE TABLE singers (
      singer_id STRING(36) NOT NULL,
      name STRING(MAX) NOT NULL
    ) PRIMARY KEY (singer_id)`,
    `CREATE TABLE albums (
      singer_id STRING(36) NOT NULL,
      album_id STRING(36) NOT NULL,
      title STRING(1024),
      plays INT64
    ) PRIMARY KEY (singer_id, album_id),
      INTERLEAVE IN PARENT singers ON DELETE CASCADE`,
    `CREATE TABLE tracks (
      singer_id STRING(36) NOT NULL,
      album_id STRING(36) NOT NULL,
      track_id STRING(36) NOT NULL,
      title STRING(1024)
    ) PRIMARY KEY (singer_id, album_id, track_id),
      INTERLEAVE IN PARENT albums ON DELETE CASCADE`
  ])
  db = makeDb(harness.db.$client!)

  await db.insert(singers).values([
    { singerId: 's1', name: 'Ada' },
    { singerId: 's2', name: 'Grace' }
  ])
  await db.insert(albums).values([
    { singerId: 's1', albumId: 'a1', title: 'Analytical Engine', plays: 30 },
    { singerId: 's1', albumId: 'a2', title: 'Bernoulli', plays: 10 },
    { singerId: 's1', albumId: 'a3', title: 'Ada Live', plays: 20 },
    { singerId: 's2', albumId: 'a4', title: 'Compilers', plays: 40 }
  ])
  await db.insert(tracks).values([
    { singerId: 's1', albumId: 'a1', trackId: 't1', title: 'Opening' },
    { singerId: 's1', albumId: 'a1', trackId: 't2', title: 'Loop' },
    { singerId: 's1', albumId: 'a2', trackId: 't3', title: 'Numbers' }
  ])
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('relational queries on the interleaved singers/albums pair', () => {
  it('findMany returns nested collections decoded from ARRAY<STRUCT>', async () => {
    const result = await db.query.singers.findMany({
      with: { albums: { orderBy: { albumId: 'asc' } } }
    })
    const byId = new Map(result.map((row) => [row.singerId, row]))
    expect(byId.get('s1')!.albums.map((album) => album.albumId)).toEqual([
      'a1',
      'a2',
      'a3'
    ])
    expect(byId.get('s1')!.albums[0]).toEqual({
      singerId: 's1',
      albumId: 'a1',
      title: 'Analytical Engine',
      plays: 30
    })
    expect(byId.get('s2')!.albums).toHaveLength(1)
  })

  it('applies where, orderBy, and limit on the nested collection', async () => {
    const result = await db.query.singers.findMany({
      where: { singerId: 's1' },
      with: {
        albums: {
          where: { title: { like: 'A%' } },
          orderBy: { plays: 'desc' },
          limit: 1
        }
      }
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.albums).toEqual([
      { singerId: 's1', albumId: 'a1', title: 'Analytical Engine', plays: 30 }
    ])
  })

  it('findFirst resolves a to-one relation to a single STRUCT', async () => {
    const album = await db.query.albums.findFirst({
      where: { albumId: 'a4' },
      with: { singer: true }
    })
    expect(album).toBeDefined()
    expect(album!.singer).toEqual({ singerId: 's2', name: 'Grace' })
  })

  it('nests three levels: singers → albums → tracks', async () => {
    const result = await db.query.singers.findFirst({
      where: { singerId: 's1' },
      with: {
        albums: {
          orderBy: { albumId: 'asc' },
          with: { tracks: { orderBy: { trackId: 'asc' }, columns: { title: true } } }
        }
      }
    })
    expect(result!.albums.map((album) => album.tracks)).toEqual([
      [{ title: 'Opening' }, { title: 'Loop' }],
      [{ title: 'Numbers' }],
      []
    ])
  })

  it('supports extras riding the STRUCT decode path', async () => {
    const result = await db.query.singers.findFirst({
      where: { singerId: 's1' },
      extras: {
        upperName: (table, { sql }) => sql<string>`upper(${table.name})`
      },
      with: {
        albums: {
          where: { albumId: 'a1' },
          extras: {
            titleLength: (table, { sql }) => sql<number>`char_length(${table.title})`
          }
        }
      }
    })
    expect(result!.upperName).toBe('ADA')
    expect(result!.albums[0]!.titleLength).toBe(17)
  })

  it('runs inside a read-only transaction', async () => {
    const result = await db.transaction(
      async (tx) => tx.query.singers.findMany({ with: { albums: true } }),
      { readOnly: true }
    )
    expect(result).toHaveLength(2)
  })
})
