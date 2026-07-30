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

/** Topologically orders tables parents-first by interleaving and FK targets. */
export function orderTablesParentsFirst(
  tables: TableEntity[],
  fksByTable: Map<string, ForeignKeyEntity[]>,
): TableEntity[] {
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const ordered: TableEntity[] = [];
  const visiting = new Set<string>();

  const visit = (table: TableEntity): void => {
    if (!remaining.has(table.name) || visiting.has(table.name)) return;
    visiting.add(table.name);
    const dependencies: string[] = [];
    if (table.interleave) dependencies.push(table.interleave.parent);
    for (const fk of fksByTable.get(table.name) ?? []) dependencies.push(fk.foreignTable);
    for (const dependency of dependencies) {
      const parent = remaining.get(dependency);
      if (parent && parent !== table) visit(parent);
    }
    visiting.delete(table.name);
    remaining.delete(table.name);
    ordered.push(table);
  };

  for (const table of tables) visit(table);
  return ordered;
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
