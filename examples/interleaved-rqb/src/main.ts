// Interleaved singers/albums: buffered-mutation writes, a relational query
// compiled to ARRAY(SELECT AS STRUCT), and a stale read. The schema was
// applied by `drizzle-spanner-kit push` (see package.json's start script).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Spanner } from '@google-cloud/spanner'
import { eq } from 'drizzle-orm/sql/expressions'
import { drizzle } from 'drizzle-spanner'

import { albums, relations, singers } from './schema.ts'

process.env.SPANNER_EMULATOR_HOST ??= 'localhost:9010'

const spanner = new Spanner({
  projectId: process.env.SPANNER_PROJECT_ID ?? 'example-project'
})
const database = spanner
  .instance(process.env.SPANNER_INSTANCE_ID ?? 'example-instance')
  .database(process.env.SPANNER_DATABASE_ID ?? 'interleaved-rqb')

const db = drizzle(database, { relations })

// Start clean so the example can be re-run against a long-lived emulator;
// ON DELETE CASCADE removes the interleaved albums with their singers.
await db.delete(singers)

// Buffered mutations: the cheapest write path for bulk writes that don't
// read. Inserts compile to Spanner mutations buffered until commit; reads
// and .returning() would throw in this mode.
const adaId = randomUUID()
const graceId = randomUUID()
await db.transaction(
  async (tx) => {
    await tx.insert(singers).values([
      { singerId: adaId, name: 'Ada' },
      { singerId: graceId, name: 'Grace' }
    ])
    await tx.insert(albums).values([
      { singerId: adaId, albumId: randomUUID(), title: 'Analytical Engine' },
      { singerId: adaId, albumId: randomUUID(), title: 'Notes' },
      { singerId: graceId, albumId: randomUUID(), title: 'COBOL Sessions' }
    ])
  },
  { mode: 'bufferedMutations' }
)

// Relational query: nested collections compile to one round trip via
// correlated ARRAY(SELECT AS STRUCT ... ORDER BY ...) subqueries.
const withAlbums = await db.query.singers.findMany({
  with: { albums: { orderBy: { title: 'asc' } } },
  orderBy: { name: 'asc' }
})
assert.deepEqual(
  withAlbums.map((singer) => [singer.name, singer.albums.map((album) => album.title)]),
  [
    ['Ada', ['Analytical Engine', 'Notes']],
    ['Grace', ['COBOL Sessions']]
  ]
)
console.log('relational query returned', withAlbums.length, 'singers with albums')

// Stale read: a single-use bounded read at a timestamp after the commit
// sees the data; the same read bounded before the insert sees nothing.
const afterCommit = new Date()
const staleRows = await db
  .select()
  .from(singers)
  .where(eq(singers.singerId, adaId))
  .withStaleness({ readTimestamp: afterCommit })
assert.equal(staleRows.length, 1)
console.log('stale read at', afterCommit.toISOString(), 'saw', staleRows[0]!.name)

console.log('interleaved-rqb example passed')
await database.close()
spanner.close()
