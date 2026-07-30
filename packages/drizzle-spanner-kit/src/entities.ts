import type {
  CheckEntity,
  ColumnEntity,
  ForeignKeyEntity,
  IndexEntity,
  PrimaryKeyEntity,
  SequenceEntity,
  SpannerEntity,
  TableEntity,
} from './snapshot.js';

/** A snapshot's flat entity list bucketed per entity type. */
export interface EntityBuckets {
  tables: TableEntity[];
  columns: ColumnEntity[];
  pks: PrimaryKeyEntity[];
  indexes: IndexEntity[];
  fks: ForeignKeyEntity[];
  checks: CheckEntity[];
  sequences: SequenceEntity[];
}

export function bucketEntities(entities: SpannerEntity[]): EntityBuckets {
  const buckets: EntityBuckets = {
    tables: [],
    columns: [],
    pks: [],
    indexes: [],
    fks: [],
    checks: [],
    sequences: [],
  };
  for (const entity of entities) {
    switch (entity.entityType) {
      case 'tables':
        buckets.tables.push(entity);
        break;
      case 'columns':
        buckets.columns.push(entity);
        break;
      case 'pks':
        buckets.pks.push(entity);
        break;
      case 'indexes':
        buckets.indexes.push(entity);
        break;
      case 'fks':
        buckets.fks.push(entity);
        break;
      case 'checks':
        buckets.checks.push(entity);
        break;
      case 'sequences':
        buckets.sequences.push(entity);
        break;
    }
  }
  return buckets;
}

/** Groups table-scoped entities into per-table lists, preserving order. */
export function groupByTable<T extends { table: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.table);
    if (group) group.push(item);
    else groups.set(item.table, [item]);
  }
  return groups;
}
