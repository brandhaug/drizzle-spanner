import { describe, expect, it } from 'bun:test'
import { int64, spannerTable } from 'drizzle-spanner'
import { parseSnapshot, type SpannerEntity } from '../../src/snapshot.js'
import { serializeSchema } from '../../src/serializer.js'
import { validateSchemaEntities } from '../../src/schema-validation.js'

function schema(): Array<SpannerEntity> {
  return serializeSchema({
    items: spannerTable('items', { id: int64('id').primaryKey() })
  })
}

function parse(ddl: unknown, extra: Record<string, unknown> = {}) {
  return parseSnapshot(
    JSON.stringify({ version: '8', dialect: 'spanner', id: 'snapshot', ddl, ...extra }),
    'snapshot.json'
  )
}

describe('snapshot validation', () => {
  it('accepts a complete schema and preserves column and primary-key ordering', () => {
    const ddl = schema()
    expect(parse(ddl).ddl).toEqual(ddl)
    expect(parse(ddl).prevIds).toEqual([])
    expect(parse(ddl).renames).toEqual([])
  })

  it('rejects malformed envelopes with a source-specific error', () => {
    for (const value of [null, [], 4, 'snapshot']) {
      expect(() => parseSnapshot(JSON.stringify(value), 'broken.json')).toThrow(
        'broken.json must be an object'
      )
    }
    expect(() => parse(schema(), { prevIds: 'previous' })).toThrow(
      'snapshot.json.prevIds must be an array'
    )
    expect(() => parse(schema(), { renames: [null] })).toThrow(
      'snapshot.json.renames[0]'
    )
    expect(() => parse(schema(), { id: '' })).toThrow('snapshot.json.id')
  })

  it('rejects missing and mistyped entity fields at their exact paths', () => {
    const ddl = schema()
    const column = ddl.find((entity) => entity.entityType === 'columns')!
    for (const malformed of [
      { ...column, type: undefined },
      { ...column, notNull: 'true' },
      { ...column, generated: { as: '1', stored: 'false' } },
      { ...column, generatedIdentity: undefined },
      { ...column, allowCommitTimestamp: 0 }
    ]) {
      expect(() => parse([ddl[0], malformed, ddl[2]])).toThrow('snapshot.json.ddl[1]')
    }
    expect(() => parse([null])).toThrow('snapshot.json.ddl[0]')
    expect(() => parse([{ entityType: 'views' }])).toThrow('unknown entity type views')
  })

  it('rejects duplicates and orphaned entities before map indexing can discard them', () => {
    const ddl = schema()
    expect(() => parse([...ddl, ddl[0]])).toThrow('duplicate tables')
    expect(() => parse([...ddl, ddl[1]])).toThrow('duplicate columns')
    expect(() => parse([...ddl, ddl[2]])).toThrow('duplicate pks')
    expect(() => parse(ddl.slice(1))).toThrow('missing table "items"')
  })

  it('requires a primary key whose parts name distinct existing columns', () => {
    const ddl = schema()
    expect(() => parse(ddl.filter((entity) => entity.entityType !== 'pks'))).toThrow(
      'has no primary key'
    )
    const withoutKey = ddl.filter((entity) => entity.entityType !== 'pks')
    for (const columns of [
      [],
      [{ name: 'missing', order: 'asc' }],
      [
        { name: 'id', order: 'asc' },
        { name: 'id', order: 'desc' }
      ]
    ]) {
      expect(() =>
        parse([...withoutKey, { entityType: 'pks', table: 'items', columns }])
      ).toThrow()
    }
  })

  it('validates index references and foreign-key arity', () => {
    const ddl = schema()
    const index = {
      entityType: 'indexes',
      table: 'items',
      name: 'idx',
      columns: [{ name: 'id', order: 'asc' }],
      unique: false,
      nullFiltered: false,
      storing: ['missing']
    }
    expect(() => parse([...ddl, index])).toThrow('missing column "items.missing"')
    const fk = {
      entityType: 'fks',
      table: 'items',
      name: 'fk',
      columns: ['id'],
      foreignTable: 'missing',
      foreignColumns: ['id'],
      onDelete: 'noAction'
    }
    expect(() => parse([...ddl, fk])).toThrow('missing table "missing"')
    expect(() =>
      parse([...ddl, { ...fk, foreignTable: 'items', foreignColumns: [] }])
    ).toThrow('must name at least one column')
  })

  it('allows foreign-key cycles but rejects interleave cycles and missing parents', () => {
    const ddl = schema()
    const fk = {
      entityType: 'fks',
      table: 'items',
      name: 'self_reference',
      columns: ['id'],
      foreignTable: 'items',
      foreignColumns: ['id'],
      onDelete: 'noAction'
    }
    expect(parse([...ddl, fk]).ddl).toHaveLength(4)
    const rest = ddl.filter((entity) => entity.entityType !== 'tables')
    expect(() =>
      parse([
        {
          entityType: 'tables',
          name: 'items',
          interleave: { parent: 'items', onDelete: 'noAction' }
        },
        ...rest
      ])
    ).toThrow('interleave cycle')
    expect(() =>
      parse([
        {
          entityType: 'tables',
          name: 'items',
          interleave: { parent: 'missing', onDelete: 'noAction' }
        },
        ...rest
      ])
    ).toThrow('missing table "missing"')
  })

  it('uses the same validation boundary for in-memory schemas', () => {
    expect(() =>
      validateSchemaEntities(
        [{ entityType: 'tables', name: 'empty', interleave: null }],
        'schema exports'
      )
    ).toThrow('schema exports table "empty" has no primary key')
    expect(validateSchemaEntities([], 'empty schema')).toEqual([])
  })
})
