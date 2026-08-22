import { describe, expect, it } from 'bun:test'
import { renderSchemaModule } from '../../src/codegen.js'
import type { SpannerEntity } from '../../src/snapshot.js'

describe('renderSchemaModule', () => {
  it('renders tables with columns, keys, interleaving, indexes, constraints and sequences', () => {
    const entities: SpannerEntity[] = [
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

    expect(renderSchemaModule(entities)).toBe(`import { sql } from 'drizzle-orm/sql';
import {
  check,
  foreignKey,
  index,
  int64,
  interleaveInParent,
  primaryKey,
  sequence,
  spannerTable,
  string,
  timestamp,
} from 'drizzle-spanner';

export const singerIds = sequence('singer_ids');

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).notNull().defaultGenerateUuid().primaryKey(),
  fullName: string('full_name', { length: 'max' }).notNull(),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true }),
});

export const albums = spannerTable(
  'albums',
  {
    id: string('id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    plays: int64('plays'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.albumId.desc()] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_plays').on(t.plays).nullFiltered().storing(t.albumId),
    foreignKey({
      name: 'fk_albums_singer',
      columns: [t.id],
      foreignColumns: [singers.id],
    }).onDelete('cascade'),
    check('positive_plays', sql\`plays >= 0\`),
  ],
);
`)
  })

  it('renders single ascending primary keys inline on the column', () => {
    const entities: SpannerEntity[] = [
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
      "id: int64('id').notNull().generatedAsIdentity().primaryKey(),"
    )
    expect(source).not.toContain('primaryKey({')
  })

  it('renders arrays, generated columns and plain SQL defaults', () => {
    const entities: SpannerEntity[] = [
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
    const source = renderSchemaModule(entities)
    expect(source).toContain("tags: string('tags', { length: 64 }).array(),")
    expect(source).toContain(
      "created: timestamp('created').default(sql`CURRENT_TIMESTAMP()`),"
    )
    expect(source).toContain(
      "shadow: tokenlist('shadow').generatedAlwaysAs(sql`TOKENIZE_FULLTEXT(id)`),"
    )
  })
})
