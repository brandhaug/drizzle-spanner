import { describe, expect, it } from 'bun:test'
import { assertSchemaRoundtrip } from '../../src/schema-roundtrip.js'
import { type SpannerEntity } from '../../src/snapshot.js'

const introspected: Array<SpannerEntity> = [
  { entityType: 'tables', name: 'items', interleave: null },
  {
    entityType: 'columns',
    table: 'items',
    name: 'computed',
    type: 'INT64',
    notNull: false,
    default: null,
    generated: { as: '1', stored: false },
    generatedIdentity: false,
    allowCommitTimestamp: false
  },
  {
    entityType: 'indexes',
    table: 'items',
    name: 'idx',
    columns: [{ name: 'computed', order: 'asc' }],
    storing: ['first', 'second'],
    unique: false,
    nullFiltered: false
  }
]

describe('pull schema fidelity', () => {
  it('rejects a baseline whose emitted module changed generated-column storage', () => {
    const generated = introspected.map((entity) =>
      entity.entityType === 'columns'
        ? { ...entity, generated: { as: '1', stored: true } }
        : entity
    )
    expect(() => assertSchemaRoundtrip(introspected, generated)).toThrow(
      'refusing to publish a pull baseline'
    )
  })

  it('accepts reordered entities and STORING columns without changing either input', () => {
    const generated = introspected
      .map((entity) =>
        entity.entityType === 'indexes'
          ? { ...entity, storing: ['second', 'first'] }
          : entity
      )
      .toReversed()
    expect(() => assertSchemaRoundtrip(introspected, generated)).not.toThrow()
    expect(
      generated.find((entity) => entity.entityType === 'indexes')?.storing
    ).toEqual(['second', 'first'])
  })

  it('rejects missing and extra entities', () => {
    expect(() => assertSchemaRoundtrip(introspected, introspected.slice(1))).toThrow(
      'does not preserve'
    )
    expect(() => assertSchemaRoundtrip(introspected.slice(1), introspected)).toThrow(
      'entities absent'
    )
  })
})
