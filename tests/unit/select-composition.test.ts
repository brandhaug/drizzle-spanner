import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import { desc, eq, isNotNull } from 'drizzle-orm/sql/expressions'
import { sql } from 'drizzle-orm/sql'
import {
  bool,
  drizzle,
  inUnnest,
  search,
  spannerTable,
  string,
  timestamp,
  tokenlist
} from '../../src/index.js'
import {
  type SpannerDriverDatabase,
  type SpannerDriverRow,
  type SpannerSqlRequest
} from '../../src/index.js'

const current = spannerTable('current_entities', {
  id: string('id', { length: 'max' }).primaryKey(),
  isStale: bool('is_stale'),
  syncedAt: timestamp('synced_at'),
  tokens: tokenlist('tokens')
})

const legacy = spannerTable('legacy_entities', {
  id: string('id', { length: 'max' }).primaryKey(),
  isStale: bool('is_stale'),
  syncedAt: timestamp('synced_at'),
  tokens: tokenlist('tokens')
})

const db = drizzle.mock()

describe('grouping', () => {
  it('renders group by and having after where', () => {
    const query = db
      .select({ id: current.id, latest: sql<Date>`max(${current.syncedAt})` })
      .from(current)
      .where(isNotNull(current.syncedAt))
      .groupBy(current.id)
      .having(sql`count(*) > ${1}`)
      .toSQL()
    expect(query.sql).toBe(
      'select `current_entities`.`id`, max(`current_entities`.`synced_at`) from `current_entities` where (`current_entities`.`synced_at` is not null) group by `current_entities`.`id` having count(*) > @p0'
    )
    expect(query.params).toEqual([1])
  })
})

describe('set operations', () => {
  const copies = (table: typeof current | typeof legacy, rank: number) =>
    db
      .select({
        id: table.id,
        isStale: table.isStale,
        rank: sql<number>`${sql.raw(String(rank))}`.as('rank')
      })
      .from(table)
      .where(eq(table.id, 'E1'))

  it('names ALL or DISTINCT and orders the combined rows by output column', () => {
    const query = copies(current, 0)
      .unionAll(copies(legacy, 1))
      .orderBy(current.id, sql`rank`, desc(current.isStale))
      .limit(10)
      .toSQL()
    expect(query.sql).toBe(
      '(select `current_entities`.`id`, `current_entities`.`is_stale`, 0 as `rank` from `current_entities` where `current_entities`.`id` = @p0)' +
        ' union all ' +
        '(select `legacy_entities`.`id`, `legacy_entities`.`is_stale`, 1 as `rank` from `legacy_entities` where `legacy_entities`.`id` = @p1)' +
        ' order by `id`, rank, `is_stale` desc limit @p2'
    )
    expect(query.params).toEqual(['E1', 'E1', 10])
  })

  it('renders bare union as UNION DISTINCT, which GoogleSQL requires', () => {
    const query = copies(current, 0)
      .union(copies(legacy, 1))
      .union(copies(legacy, 2))
      .toSQL()
    expect(query.sql).toMatch(
      /^\(select [^)]*\) union distinct \(select [^)]*\) union distinct \(select [^)]*\)$/
    )
  })

  it('parenthesises the rows so far when the set operator changes, as GoogleSQL requires', () => {
    const query = copies(current, 0)
      .unionAll(copies(legacy, 1))
      .except(copies(legacy, 2))
      .toSQL()
    expect(query.sql).toMatch(
      /^\(\(select [^)]*\) union all \(select [^)]*\)\) except distinct \(select [^)]*\)$/
    )
  })

  it('leaves a set operation unchanged when another is chained onto it', () => {
    const both = copies(current, 0).unionAll(copies(legacy, 1))
    const fewer = both.except(copies(legacy, 2))
    expect(both.toSQL().sql).not.toContain('except')
    expect(fewer.toSQL().sql).toContain(') except distinct (')
  })

  it('names the output column of a column nested in an ORDER BY expression', () => {
    const query = copies(current, 0)
      .unionAll(copies(legacy, 1))
      .orderBy(desc(sql`lower(${current.id})`))
      .toSQL()
    expect(query.sql).toEndWith(' order by lower(`id`) desc')
  })
})

describe('subqueries', () => {
  it('selects from an aliased select, qualified by the alias', () => {
    const copies = db
      .select({ id: current.id, latest: sql<Date>`${current.syncedAt}`.as('latest') })
      .from(current)
      .as('copies')
    const query = db.select().from(copies).where(eq(copies.id, 'E1')).toSQL()
    expect(query.sql).toBe(
      'select `copies`.`id`, `copies`.`latest` from (select `current_entities`.`id`, `current_entities`.`synced_at` as `latest` from `current_entities`) `copies` where `copies`.`id` = @p0'
    )
  })
})

describe('Spanner expressions', () => {
  it('binds inUnnest values as one ARRAY parameter typed by the column', () => {
    const query = db.dialect.sqlToQuery(
      db
        .select({ id: current.id })
        .from(current)
        .where(inUnnest(current.id, ['a', 'b']))
        .getSQL()
    )
    expect(query.sql).toBe(
      'select `current_entities`.`id` from `current_entities` where `current_entities`.`id` in unnest(@p0)'
    )
    expect(query.params).toEqual([['a', 'b']])
    expect(query.typings).toEqual(['array:string'])
    expect(query.paramColumns).toEqual(['id'])
  })

  it('keeps the same SQL text for any number of values', () => {
    const text = (ids: Array<string>) =>
      db
        .select({ id: current.id })
        .from(current)
        .where(inUnnest(current.id, ids))
        .toSQL().sql
    expect(text([])).toBe(text(['a', 'b', 'c']))
  })

  it('renders SEARCH over a tokenlist column', () => {
    const query = db
      .select({ id: current.id })
      .from(current)
      .where(search(current.tokens, 'a OR b'))
      .toSQL()
    expect(query.sql).toBe(
      'select `current_entities`.`id` from `current_entities` where search(`current_entities`.`tokens`, @p0)'
    )
    expect(query.params).toEqual(['a OR b'])
  })
})

function row(id: string): SpannerDriverRow {
  return [{ name: 'id', value: id }]
}

function fakeDatabase() {
  const requests: Array<SpannerSqlRequest> = []
  const streams: Array<PassThrough> = []
  const snapshots = { opened: 0, ended: 0 }
  const database: SpannerDriverDatabase = {
    async run(request) {
      requests.push(request)
      return [[row('ran')]]
    },
    async runTransactionAsync() {
      throw new Error('not used')
    },
    async getSnapshot() {
      snapshots.opened += 1
      return [
        {
          async run() {
            throw new Error('not used')
          },
          runStream(request: SpannerSqlRequest) {
            requests.push(request)
            const stream = new PassThrough({ objectMode: true })
            streams.push(stream)
            return stream
          },
          end() {
            snapshots.ended += 1
          }
        }
      ] as const
    }
  }
  return { database, requests, streams, snapshots }
}

// Until the read has opened its snapshot and asked for the stream.
const streamOpened = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

describe('request options and cancellation', () => {
  it('keeps the options and signal set on the select a set operation starts from', async () => {
    const fake = fakeDatabase()
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withRequestOptions({ requestTag: 'entity_read' })
      .withSignal(new AbortController().signal)
      .unionAll(drizzle(fake.database).select({ id: legacy.id }).from(legacy))
      .execute()
    await streamOpened()
    fake.streams[0]!.end(row('streamed'))
    expect(await read).toEqual([{ id: 'streamed' }])
    expect(fake.requests[0]?.requestOptions).toEqual({ requestTag: 'entity_read' })
  })

  it('sends the request tag and priority with the request', async () => {
    const fake = fakeDatabase()
    await drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withRequestOptions({ requestTag: 'entity_read', priority: 'low' })
    expect(fake.requests[0]?.requestOptions).toEqual({
      requestTag: 'entity_read',
      priority: 'PRIORITY_LOW'
    })
  })

  it("reads through a snapshot's row stream when given a signal, and ends the snapshot", async () => {
    const fake = fakeDatabase()
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withSignal(new AbortController().signal)
      .execute()
    await streamOpened()
    fake.streams[0]!.end(row('streamed'))
    expect(await read).toEqual([{ id: 'streamed' }])
    expect(fake.snapshots).toEqual({ opened: 1, ended: 1 })
  })

  it('destroys the stream, ends the snapshot and rejects with the reason when the signal aborts', async () => {
    const fake = fakeDatabase()
    const controller = new AbortController()
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withSignal(controller.signal)
      .execute()
    await streamOpened()
    const reason = new Error('client went away')
    controller.abort(reason)
    expect(read).rejects.toBe(reason)
    await read.catch(() => undefined)
    expect(fake.streams[0]!.destroyed).toBe(true)
    expect(fake.snapshots).toEqual({ opened: 1, ended: 1 })
  })

  it('rejects as soon as the signal aborts while the snapshot is opening, and ends it once open', async () => {
    const fake = fakeDatabase()
    const opening = Promise.withResolvers<undefined>()
    const open = fake.database.getSnapshot.bind(fake.database)
    fake.database.getSnapshot = async (bounds) => {
      await opening.promise
      return open(bounds)
    }
    const controller = new AbortController()
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withSignal(controller.signal)
      .execute()
    await streamOpened()
    controller.abort(new Error('deadline'))
    expect(read).rejects.toThrow('deadline')
    await read.catch(() => undefined)
    expect(fake.snapshots).toEqual({ opened: 0, ended: 0 })
    opening.resolve(undefined)
    await streamOpened()
    expect(fake.snapshots).toEqual({ opened: 1, ended: 1 })
    expect(fake.requests).toHaveLength(0)
  })

  it('rejects at once for a signal that already aborted, without a snapshot', async () => {
    const fake = fakeDatabase()
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withSignal(controller.signal)
      .execute()
    expect(read).rejects.toThrow('gone')
    await read.catch(() => undefined)
    expect(fake.snapshots.opened).toBe(0)
  })

  it('refuses a single-use staleness bound on a cancellable read', async () => {
    const fake = fakeDatabase()
    const read = drizzle(fake.database)
      .select({ id: current.id })
      .from(current)
      .withStaleness({ maxStaleness: '10s' })
      .withSignal(new AbortController().signal)
      .execute()
    expect(read).rejects.toThrow(
      'maxStaleness and minReadTimestamp are single-use bounds'
    )
    await read.catch(() => undefined)
    expect(fake.snapshots.opened).toBe(0)
  })

  it('offers no signal on DML', () => {
    const fake = fakeDatabase()
    const write = drizzle(fake.database)
      .delete(current)
      .where(eq(current.id, 'E1'))
      .withRequestOptions({ requestTag: 'cleanup' })
    expect('withSignal' in write).toBe(false)
  })
})
