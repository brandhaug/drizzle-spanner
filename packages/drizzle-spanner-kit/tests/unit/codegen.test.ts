import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSchemaExports } from '../../src/loader.js'
import { serializeSchema } from '../../src/serializer.js'
import { assertSchemaRoundtrip } from '../../src/schema-roundtrip.js'
import { renderSchemaModule } from '../../src/codegen.js'
import { type SpannerEntity } from '../../src/snapshot.js'

async function roundtrip(
  entities: Array<SpannerEntity>
): Promise<Array<SpannerEntity>> {
  const directory = await mkdtemp(join(import.meta.dirname, '.codegen-'))
  try {
    const schemaFile = join(directory, 'schema.ts')
    await writeFile(schemaFile, renderSchemaModule(entities))
    const serialized = serializeSchema(await loadSchemaExports([schemaFile]))
    assertSchemaRoundtrip(entities, serialized)
    return serialized
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('renderSchemaModule', () => {
  it('preserves SQL text and virtual generated columns when importing emitted code', async () => {
    const literal = String.raw`'${'$'}{1+1} backtick \` backslash \\ quote "'`
    const entities: Array<SpannerEntity> = [
      { entityType: 'tables', name: 'expressions', interleave: null },
      {
        entityType: 'columns',
        table: 'expressions',
        name: 'id',
        type: 'INT64',
        notNull: false,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'expressions',
        name: 'text',
        type: 'STRING(MAX)',
        notNull: false,
        default: literal,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'expressions',
        name: 'computed',
        type: 'STRING(MAX)',
        notNull: false,
        default: null,
        generated: { as: literal, stored: false },
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'pks',
        table: 'expressions',
        columns: [{ name: 'id', order: 'asc' }]
      },
      {
        entityType: 'checks',
        table: 'expressions',
        name: 'literal_check',
        value: `${literal} IS NOT NULL`
      }
    ]
    const serialized = await roundtrip(entities)
    expect(
      serialized.find(
        (entity) => entity.entityType === 'columns' && entity.name === 'computed'
      )
    ).toMatchObject({ generated: { as: literal, stored: false } })
    expect(
      serialized.find(
        (entity) => entity.entityType === 'columns' && entity.name === 'id'
      )
    ).toMatchObject({ notNull: false })
  })

  it('roundtrips tables, columns, keys, interleaving, indexes, constraints and sequences', async () => {
    const entities: Array<SpannerEntity> = [
      { entityType: 'sequences', name: 'singer_ids', kind: 'bit_reversed_positive' },
      { entityType: 'tables', name: 'singers', interleave: null },
      {
        entityType: 'columns',
        table: 'singers',
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
        table: 'singers',
        name: 'full_name',
        type: 'STRING(MAX)',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'singers',
        name: 'updated_at',
        type: 'TIMESTAMP',
        notNull: false,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: true
      },
      { entityType: 'pks', table: 'singers', columns: [{ name: 'id', order: 'asc' }] },
      {
        entityType: 'tables',
        name: 'albums',
        interleave: { parent: 'singers', onDelete: 'cascade' }
      },
      {
        entityType: 'columns',
        table: 'albums',
        name: 'id',
        type: 'STRING(36)',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'albums',
        name: 'album_id',
        type: 'STRING(36)',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 'albums',
        name: 'plays',
        type: 'INT64',
        notNull: false,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'pks',
        table: 'albums',
        columns: [
          { name: 'id', order: 'asc' },
          { name: 'album_id', order: 'desc' }
        ]
      },
      {
        entityType: 'indexes',
        table: 'albums',
        name: 'idx_albums_plays',
        columns: [{ name: 'plays', order: 'asc' }],
        unique: false,
        nullFiltered: true,
        storing: ['album_id']
      },
      {
        entityType: 'fks',
        table: 'albums',
        name: 'fk_albums_singer',
        columns: ['id'],
        foreignTable: 'singers',
        foreignColumns: ['id'],
        onDelete: 'cascade'
      },
      {
        entityType: 'checks',
        table: 'albums',
        name: 'positive_plays',
        value: 'plays >= 0'
      }
    ]

    await roundtrip(entities)
  })

  it('renders single ascending primary keys inline on the column', () => {
    const entities: Array<SpannerEntity> = [
      { entityType: 'tables', name: 't', interleave: null },
      {
        entityType: 'columns',
        table: 't',
        name: 'id',
        type: 'INT64',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: true,
        allowCommitTimestamp: false
      },
      { entityType: 'pks', table: 't', columns: [{ name: 'id', order: 'asc' }] }
    ]
    const source = renderSchemaModule(entities)
    expect(source).toContain(
      'id: int64("id").notNull().generatedAsIdentity().primaryKey(),'
    )
    expect(source).not.toContain('primaryKey({')
  })

  it('roundtrips arrays, generated columns and plain SQL defaults', async () => {
    const entities: Array<SpannerEntity> = [
      { entityType: 'tables', name: 't', interleave: null },
      {
        entityType: 'columns',
        table: 't',
        name: 'id',
        type: 'STRING(36)',
        notNull: true,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 't',
        name: 'tags',
        type: 'ARRAY<STRING(64)>',
        notNull: false,
        default: null,
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 't',
        name: 'created',
        type: 'TIMESTAMP',
        notNull: false,
        default: 'CURRENT_TIMESTAMP()',
        generated: null,
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      {
        entityType: 'columns',
        table: 't',
        name: 'shadow',
        type: 'TOKENLIST',
        notNull: false,
        default: null,
        generated: { as: 'TOKENIZE_FULLTEXT(id)', stored: true },
        generatedIdentity: false,
        allowCommitTimestamp: false
      },
      { entityType: 'pks', table: 't', columns: [{ name: 'id', order: 'asc' }] }
    ]
    await roundtrip(entities)
  })
})
