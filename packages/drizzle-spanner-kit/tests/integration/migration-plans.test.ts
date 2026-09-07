import { afterAll, beforeAll, expect, it } from 'bun:test'
import { diffSnapshots } from '../../src/differ.js'
import { introspectDatabase } from '../../src/introspect.js'
import { type KitDriverDatabase } from '../../src/connect.js'
import { type SpannerEntity } from '../../src/snapshot.js'
import { type KitEmulatorHarness, startKitEmulator } from './harness.js'

let harness: KitEmulatorHarness
beforeAll(async () => {
  harness = await startKitEmulator()
}, 180_000)
afterAll(async () => {
  await harness?.cleanup()
})

it('creates and drops mutually referencing tables through the generated DDL plan', async () => {
  const { database } = await harness.createDatabase('cyclic-foreign-keys')
  const entities: Array<SpannerEntity> = ['first', 'second'].flatMap(
    (name): Array<SpannerEntity> => [
      { entityType: 'tables', name, interleave: null },
      {
        entityType: 'columns',
        table: name,
        name: 'id',
        type: 'INT64',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      { entityType: 'pks', table: name, columns: [{ name: 'id', order: 'asc' }] },
      {
        entityType: 'fks',
        table: name,
        name: `fk_${name}`,
        columns: ['id'],
        foreignTable: name === 'first' ? 'second' : 'first',
        foreignColumns: ['id'],
        onDelete: 'noAction'
      }
    ]
  )
  const create = await diffSnapshots([], entities)
  const [creation] = await database.updateSchema(create.statements)
  await creation.promise()
  const live = await introspectDatabase(database as KitDriverDatabase)
  expect(live.filter((entity) => entity.entityType === 'fks')).toHaveLength(2)
  const drop = await diffSnapshots(live, [], { acceptDrops: true })
  const [deletion] = await database.updateSchema(drop.statements)
  await deletion.promise()
  expect(await introspectDatabase(database as KitDriverDatabase)).toEqual([])
})
