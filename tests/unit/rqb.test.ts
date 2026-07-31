import { describe, expect, it } from 'vitest'
import { defineRelations } from 'drizzle-orm/relations'
import {
  drizzle,
  int64,
  primaryKey,
  spannerTable,
  string,
  timestamp
} from '../../src/index.js'
import type { SpannerDriverDatabase, SpannerDriverRow } from '../../src/index.js'

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' }).notNull()
})

const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 }),
    plays: int64('plays'),
    releasedAt: timestamp('released_at')
  },
  (t) => [primaryKey({ columns: [t.singerId, t.albumId] })]
)

const tracks = spannerTable(
  'tracks',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    trackId: string('track_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 })
  },
  (t) => [primaryKey({ columns: [t.singerId, t.albumId, t.trackId] })]
)

const relations = defineRelations({ singers, albums, tracks }, (r) => ({
  singers: {
    albums: r.many.albums()
  },
  albums: {
    singer: r.one.singers({
      from: r.albums.singerId,
      to: r.singers.id
    }),
    tracks: r.many.tracks()
  },
  tracks: {
    album: r.one.albums({
      from: [r.tracks.singerId, r.tracks.albumId],
      to: [r.albums.singerId, r.albums.albumId]
    })
  }
}))

const db = drizzle.mock({ relations })

describe('relational queries: golden SQL', () => {
  it('compiles a nested collection to a correlated ARRAY(SELECT AS STRUCT ...)', () => {
    const query = db.query.singers.findMany({ with: { albums: true } })
    expect(query.toSQL().sql).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name`, ' +
        'array(select as struct `d1`.`singer_id` as `singerId`, `d1`.`album_id` as `albumId`, `d1`.`title` as `title`, `d1`.`plays` as `plays`, `d1`.`released_at` as `releasedAt` ' +
        'from `albums` as `d1` where `d0`.`id` = `d1`.`singer_id`) as `albums` ' +
        'from `singers` as `d0`'
    )
  })

  it('compiles a to-one relation to an ARRAY(SELECT AS STRUCT ... LIMIT 1) subquery', () => {
    // Spanner cannot return a bare STRUCT column, so to-one also rides ARRAY
    // and the decoder unwraps the single element.
    const query = db.query.albums.findMany({
      columns: { title: true },
      with: { singer: true }
    })
    expect(query.toSQL().sql).toBe(
      'select `d0`.`title` as `title`, ' +
        'array(select as struct `d1`.`id` as `id`, `d1`.`name` as `name` ' +
        'from `singers` as `d1` where `d0`.`singer_id` = `d1`.`id` limit @p0) as `singer` ' +
        'from `albums` as `d0`'
    )
  })

  it('supports where, orderBy, and limit on nested collections', () => {
    const query = db.query.singers.findMany({
      with: {
        albums: {
          where: { title: { like: 'A%' } },
          orderBy: { title: 'asc' },
          limit: 10
        }
      }
    })
    const { sql: text, params } = query.toSQL()
    expect(text).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name`, ' +
        'array(select as struct `d1`.`singer_id` as `singerId`, `d1`.`album_id` as `albumId`, `d1`.`title` as `title`, `d1`.`plays` as `plays`, `d1`.`released_at` as `releasedAt` ' +
        'from `albums` as `d1` where ((`d1`.`title` like @p0) and (`d0`.`id` = `d1`.`singer_id`)) ' +
        'order by `d1`.`title` asc limit @p1) as `albums` ' +
        'from `singers` as `d0`'
    )
    expect(params).toEqual(['A%', 10])
  })

  it('supports a parent where including relation filters', () => {
    const query = db.query.singers.findMany({
      where: { name: 'Ada' },
      limit: 2
    })
    const { sql: text, params } = query.toSQL()
    expect(text).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name` from `singers` as `d0` ' +
        'where `d0`.`name` = @p0 limit @p1'
    )
    expect(params).toEqual(['Ada', 2])
  })

  it('nests with at arbitrary depth (three levels)', () => {
    const query = db.query.singers.findMany({
      with: {
        albums: {
          columns: { title: true },
          with: {
            tracks: {
              columns: { title: true },
              orderBy: { trackId: 'asc' }
            }
          }
        }
      }
    })
    expect(query.toSQL().sql).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name`, ' +
        'array(select as struct `d1`.`title` as `title`, ' +
        'array(select as struct `d2`.`title` as `title` ' +
        'from `tracks` as `d2` where ((`d1`.`singer_id` = `d2`.`singer_id`) and (`d1`.`album_id` = `d2`.`album_id`)) ' +
        'order by `d2`.`track_id` asc) as `tracks` ' +
        'from `albums` as `d1` where `d0`.`id` = `d1`.`singer_id`) as `albums` ' +
        'from `singers` as `d0`'
    )
  })

  it('findFirst compiles to limit 1', () => {
    const { sql: text, params } = db.query.singers.findFirst().toSQL()
    expect(text).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name` from `singers` as `d0` limit @p0'
    )
    expect(params).toEqual([1])
  })

  it('supports extras alongside the STRUCT selection', () => {
    const query = db.query.singers.findMany({
      extras: {
        upperName: (table, { sql: sqlOp }) => sqlOp<string>`upper(${table.name})`
      },
      with: { albums: { columns: { title: true } } }
    })
    expect(query.toSQL().sql).toBe(
      'select `d0`.`id` as `id`, `d0`.`name` as `name`, ' +
        'array(select as struct `d1`.`title` as `title` from `albums` as `d1` where `d0`.`id` = `d1`.`singer_id`) as `albums`, ' +
        '(upper(`d0`.`name`)) as `upperName` ' +
        'from `singers` as `d0`'
    )
  })
})

describe('relational queries: decoding', () => {
  function fakeRqbDatabase(rows: Record<string, unknown>[]) {
    const requests: unknown[] = []
    const database: SpannerDriverDatabase = {
      async run(request: unknown) {
        requests.push(request)
        const driverRows = rows.map((row) => {
          const cells = Object.entries(row).map(([name, value]) => ({ name, value }))
          return Object.assign(cells, {
            // Returned as-is (not cloned) so wrapper instances keep their class.
            toJSON: (options?: { wrapNumbers?: boolean }) => {
              void options
              return row
            }
          })
        })
        return [driverRows] as [SpannerDriverRow[]]
      },
      async runTransactionAsync(): Promise<never> {
        throw new Error('RQB reads must not open a transaction')
      },
      async getSnapshot(): Promise<never> {
        throw new Error('RQB reads take no snapshot')
      }
    }
    return { database, requests }
  }

  it('decodes nested ARRAY<STRUCT> rows through the column decoders', async () => {
    const releasedAt = new Date('2026-01-02T03:04:05.000Z')
    const fake = fakeRqbDatabase([
      {
        id: 's1',
        name: 'Ada',
        albums: [
          {
            singerId: 's1',
            albumId: 'a1',
            title: 'First',
            // INT64 arrives wrapped; the int64 column decoder unwraps it.
            plays: { value: '42' },
            releasedAt
          }
        ]
      }
    ])
    const dbWithClient = drizzle(fake.database, { relations })
    const result = await dbWithClient.query.singers.findMany({ with: { albums: true } })
    expect(result).toEqual([
      {
        id: 's1',
        name: 'Ada',
        albums: [
          { singerId: 's1', albumId: 'a1', title: 'First', plays: 42, releasedAt }
        ]
      }
    ])
  })

  it('findFirst returns the first row or undefined', async () => {
    const empty = fakeRqbDatabase([])
    const dbEmpty = drizzle(empty.database, { relations })
    await expect(dbEmpty.query.singers.findFirst()).resolves.toBeUndefined()

    const one = fakeRqbDatabase([{ id: 's1', name: 'Ada' }])
    const dbOne = drizzle(one.database, { relations })
    await expect(dbOne.query.singers.findFirst()).resolves.toEqual({
      id: 's1',
      name: 'Ada'
    })
  })

  it('decodes a to-one relation from its one-element array, and empty to null', async () => {
    const fake = fakeRqbDatabase([
      {
        singerId: 's1',
        albumId: 'a1',
        title: 'First',
        plays: null,
        releasedAt: null,
        singer: [{ id: 's1', name: 'Ada' }]
      },
      // An empty ARRAY(... LIMIT 1): the relation row does not exist.
      {
        singerId: 's2',
        albumId: 'a2',
        title: 'Second',
        plays: null,
        releasedAt: null,
        singer: []
      }
    ])
    const dbWithClient = drizzle(fake.database, { relations })
    const result = await dbWithClient.query.albums.findMany({ with: { singer: true } })
    expect(result[0]!.singer).toEqual({ id: 's1', name: 'Ada' })
    expect(result[1]!.singer).toBeNull()
  })

  it('unwraps driver number wrappers on extras', async () => {
    // Stands in for the driver's Int wrapper: matched by constructor name.
    class Int {
      constructor(readonly value: string) {}
      valueOf(): number {
        return Number(this.value)
      }
    }
    const fake = fakeRqbDatabase([{ id: 's1', name: 'Ada', albumCount: new Int('3') }])
    const dbWithClient = drizzle(fake.database, { relations })
    const result = await dbWithClient.query.singers.findMany({
      extras: {
        albumCount: (table, { sql: sqlOp }) => sqlOp<number>`(select count(*))`
      }
    })
    expect(result[0]!.albumCount).toBe(3)
  })
})
