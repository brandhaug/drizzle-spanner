import { describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm/sql'
import {
  bool,
  bytes,
  check,
  date,
  float32,
  float64,
  foreignKey,
  index,
  int64,
  interleaveInParent,
  json,
  numeric,
  primaryKey,
  sequence,
  spannerTable,
  string,
  timestamp,
  tokenlist,
  uniqueIndex
} from 'drizzle-spanner'
import { serializeSchema } from '../../src/serializer.js'
import { createSnapshot } from '../../src/snapshot.js'

describe('serializeSchema: columns', () => {
  it('serializes all twelve Spanner types with modes', () => {
    const t = spannerTable('kitchen_sink', {
      id: string('id', { length: 36 }).primaryKey(),
      s: string('s', { length: 'max' }),
      i: int64('i'),
      ib: int64('ib', { mode: 'bigint' }),
      f64: float64('f64'),
      f32: float32('f32'),
      n: numeric('n'),
      by: bytes('by', { length: 1024 }),
      b: bool('b'),
      d: date('d'),
      ts: timestamp('ts'),
      j: json('j'),
      arr: string('arr', { length: 10 }).array()
    })
    const ddl = serializeSchema({ t })
    const columns = ddl.filter((entity) => entity.entityType === 'columns')
    expect(columns.map((column) => [column.name, column.type])).toEqual([
      ['id', 'STRING(36)'],
      ['s', 'STRING(MAX)'],
      ['i', 'INT64'],
      ['ib', 'INT64'],
      ['f64', 'FLOAT64'],
      ['f32', 'FLOAT32'],
      ['n', 'NUMERIC'],
      ['by', 'BYTES(1024)'],
      ['b', 'BOOL'],
      ['d', 'DATE'],
      ['ts', 'TIMESTAMP'],
      ['j', 'JSON'],
      ['arr', 'ARRAY<STRING(10)>']
    ])
  })

  it('serializes notNull, literal defaults and SQL defaults', () => {
    const t = spannerTable('defaults', {
      id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
      name: string('name', { length: 'max' }).notNull().default('anon'),
      plays: int64('plays').default(0),
      active: bool('active').default(true)
    })
    const columns = serializeSchema({ t }).filter(
      (entity) => entity.entityType === 'columns'
    )
    expect(columns).toEqual([
      {
        entityType: 'columns',
        table: 'defaults',
        name: 'id',
        type: 'STRING(36)',
        notNull: true,
        default: 'GENERATE_UUID()',
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'defaults',
        name: 'name',
        type: 'STRING(MAX)',
        notNull: true,
        default: "'anon'",
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'defaults',
        name: 'plays',
        type: 'INT64',
        notNull: false,
        default: '0',
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'defaults',
        name: 'active',
        type: 'BOOL',
        notNull: false,
        default: 'TRUE',
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      }
    ])
  })

  it('serializes identity columns, commit timestamps and generated columns', () => {
    const t = spannerTable('features', {
      id: int64('id').generatedAsIdentity().primaryKey(),
      updatedAt: timestamp('updated_at', { allowCommitTimestamp: true }),
      title: string('title', { length: 'max' }),
      titleTokens: tokenlist('title_tokens').generatedAlwaysAs(
        sql`TOKENIZE_FULLTEXT(title)`
      )
    })
    const columns = serializeSchema({ t }).filter(
      (entity) => entity.entityType === 'columns'
    )
    expect(columns.find((column) => column.name === 'id')).toMatchObject({
      generatedIdentity: true
    })
    expect(columns.find((column) => column.name === 'updated_at')).toMatchObject({
      allowCommitTimestamp: true
    })
    expect(columns.find((column) => column.name === 'title_tokens')).toMatchObject({
      type: 'TOKENLIST',
      generated: { as: 'TOKENIZE_FULLTEXT(title)', stored: true }
    })
  })
})

describe('serializeSchema: tables, keys and interleaving', () => {
  const singers = spannerTable('singers', {
    id: string('id', { length: 36 }).primaryKey(),
    name: string('name', { length: 'max' }).notNull()
  })

  const albums = spannerTable(
    'albums',
    {
      id: string('id', { length: 36 }).notNull(),
      albumId: string('album_id', { length: 36 }).notNull(),
      title: string('title', { length: 1024 }),
      released: date('released')
    },
    (t) => [
      primaryKey({ columns: [t.id, t.albumId.desc()] }),
      interleaveInParent(singers, { onDelete: 'cascade' }),
      index('idx_albums_title').on(t.title).nullFiltered().storing(t.released)
    ]
  )

  it('serializes table entities with interleave config', () => {
    const tables = serializeSchema({ singers, albums }).filter(
      (entity) => entity.entityType === 'tables'
    )
    expect(tables).toEqual([
      { entityType: 'tables', name: 'singers', interleave: null },
      {
        entityType: 'tables',
        name: 'albums',
        interleave: { parent: 'singers', onDelete: 'cascade' }
      }
    ])
  })

  it('serializes column-level and composite primary keys with order', () => {
    const pks = serializeSchema({ singers, albums }).filter(
      (entity) => entity.entityType === 'pks'
    )
    expect(pks).toEqual([
      { entityType: 'pks', table: 'singers', columns: [{ name: 'id', order: 'asc' }] },
      {
        entityType: 'pks',
        table: 'albums',
        columns: [
          { name: 'id', order: 'asc' },
          { name: 'album_id', order: 'desc' }
        ]
      }
    ])
  })

  it('serializes indexes with nullFiltered and storing', () => {
    const indexes = serializeSchema({ singers, albums }).filter(
      (entity) => entity.entityType === 'indexes'
    )
    expect(indexes).toEqual([
      {
        entityType: 'indexes',
        table: 'albums',
        name: 'idx_albums_title',
        columns: [{ name: 'title', order: 'asc' }],
        unique: false,
        nullFiltered: true,
        storing: ['released']
      }
    ])
  })

  it('serializes unique indexes', () => {
    const t = spannerTable(
      'u',
      { email: string('email', { length: 320 }).primaryKey() },
      (self) => [uniqueIndex('idx_u_email').on(self.email)]
    )
    const entity = serializeSchema({ t }).find((e) => e.entityType === 'indexes')
    expect(entity).toMatchObject({ unique: true, nullFiltered: false })
  })
})

describe('serializeSchema: constraints and sequences', () => {
  const singers = spannerTable('singers', {
    id: string('id', { length: 36 }).primaryKey()
  })

  it('serializes foreign keys with onDelete and a synthesized default name', () => {
    const albums = spannerTable(
      'albums',
      {
        id: string('id', { length: 36 }).primaryKey(),
        singerId: string('singer_id', { length: 36 })
      },
      (t) => [
        foreignKey({ columns: [t.singerId], foreignColumns: [singers.id] }).onDelete(
          'cascade'
        )
      ]
    )
    const fks = serializeSchema({ singers, albums }).filter(
      (entity) => entity.entityType === 'fks'
    )
    expect(fks).toEqual([
      {
        entityType: 'fks',
        table: 'albums',
        name: 'fk_albums_singer_id',
        columns: ['singer_id'],
        foreignTable: 'singers',
        foreignColumns: ['id'],
        onDelete: 'cascade'
      }
    ])
  })

  it('serializes check constraints with bare column names', () => {
    const t = spannerTable(
      'c',
      {
        id: string('id', { length: 36 }).primaryKey(),
        plays: int64('plays')
      },
      (self) => [check('positive_plays', sql`${self.plays} >= 0`)]
    )
    const checks = serializeSchema({ t }).filter(
      (entity) => entity.entityType === 'checks'
    )
    expect(checks).toEqual([
      {
        entityType: 'checks',
        table: 'c',
        name: 'positive_plays',
        value: '`plays` >= 0'
      }
    ])
  })

  it('serializes exported sequences', () => {
    const seq = sequence('singer_ids')
    const entities = serializeSchema({ seq, singers })
    expect(entities.filter((entity) => entity.entityType === 'sequences')).toEqual([
      { entityType: 'sequences', name: 'singer_ids', kind: 'bit_reversed_positive' }
    ])
  })
})

describe('createSnapshot', () => {
  it('wraps entities in the v8 envelope with dialect spanner', () => {
    const t = spannerTable('t', { id: string('id', { length: 36 }).primaryKey() })
    const ddl = serializeSchema({ t })
    const snapshot = createSnapshot(ddl, { prevIds: ['abc'], renames: ['t.a->t.b'] })
    expect(snapshot.version).toBe('8')
    expect(snapshot.dialect).toBe('spanner')
    expect(typeof snapshot.id).toBe('string')
    expect(snapshot.prevIds).toEqual(['abc'])
    expect(snapshot.renames).toEqual(['t.a->t.b'])
    expect(snapshot.ddl).toEqual(ddl)
  })
})
