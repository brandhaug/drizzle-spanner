import {
  addColumnSql,
  addConstraintSql,
  alterColumnCommitTimestampSql,
  alterColumnDefaultSql,
  alterColumnTypeSql,
  checkConstraintSql,
  createIndexSql,
  createSequenceSql,
  createTableSql,
  dropColumnSql,
  dropConstraintSql,
  dropIndexSql,
  dropSequenceSql,
  dropTableSql,
  foreignKeyConstraintSql,
  renameTableSql,
} from './ddl.js';
import { bucketEntities, groupByTable, orderTablesParentsFirst } from './entities.js';
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

/** One refused-diff finding: what cannot be altered and the manual path. */
export interface DiffDiagnostic {
  kind:
    | 'primary-key-change'
    | 'interleave-change'
    | 'column-type-change'
    | 'generated-column-change'
    | 'column-rename'
    | 'ambiguous-rename';
  table: string;
  column?: string;
  message: string;
}

/**
 * The typed refuse-and-explain failure (spec: irreversible DDL). Carries
 * every diagnostic found so one run surfaces all manual work at once.
 */
export class DiffRefusedError extends Error {
  readonly diagnostics: DiffDiagnostic[];

  constructor(diagnostics: DiffDiagnostic[]) {
    super(
      `drizzle-spanner-kit refused to generate this diff:\n${diagnostics
        .map((diagnostic) => `- ${diagnostic.message}`)
        .join('\n')}`,
    );
    this.name = 'DiffRefusedError';
    this.diagnostics = diagnostics;
  }
}

/** A possible rename the interactive flow must resolve. */
export interface RenameCandidate {
  kind: 'table' | 'column';
  /** Set for column candidates. */
  table?: string;
  dropped: string;
  created: string[];
}

/**
 * Answers a rename candidate: the created name the dropped entity was renamed
 * to, or null when it was genuinely dropped.
 */
export type RenameResolver = (candidate: RenameCandidate) => Promise<string | null>;

export interface DiffOptions {
  /** Interactive rename resolution; absent means non-interactive. */
  resolveRename?: RenameResolver;
  /**
   * Non-interactive runs refuse ambiguous renames unless this explicitly
   * allows treating them as drop+create.
   */
  acceptDrops?: boolean;
}

/**
 * A rename resolved during a diff. Column names are table-qualified
 * (`table.column`); table names are bare.
 */
export interface ResolvedRename {
  from: string;
  to: string;
}

export interface DiffResult {
  statements: string[];
  /** Rename journal entries resolved during this diff. */
  renames: ResolvedRename[];
}

interface EntityIndex {
  tables: Map<string, TableEntity>;
  columns: Map<string, Map<string, ColumnEntity>>;
  pks: Map<string, PrimaryKeyEntity>;
  indexes: Map<string, IndexEntity>;
  fks: Map<string, ForeignKeyEntity>;
  checks: Map<string, CheckEntity>;
  sequences: Map<string, SequenceEntity>;
}

function indexEntities(ddl: SpannerEntity[]): EntityIndex {
  const index: EntityIndex = {
    tables: new Map(),
    columns: new Map(),
    pks: new Map(),
    indexes: new Map(),
    fks: new Map(),
    checks: new Map(),
    sequences: new Map(),
  };
  const buckets = bucketEntities(ddl);
  for (const table of buckets.tables) {
    index.tables.set(table.name, table);
    index.columns.set(table.name, index.columns.get(table.name) ?? new Map());
  }
  for (const column of buckets.columns) {
    const tableColumns = index.columns.get(column.table) ?? new Map<string, ColumnEntity>();
    tableColumns.set(column.name, column);
    index.columns.set(column.table, tableColumns);
  }
  for (const pk of buckets.pks) index.pks.set(pk.table, pk);
  // Spanner index names are database-global.
  for (const dbIndex of buckets.indexes) index.indexes.set(dbIndex.name, dbIndex);
  for (const fk of buckets.fks) index.fks.set(`${fk.table}.${fk.name}`, fk);
  for (const check of buckets.checks) index.checks.set(`${check.table}.${check.name}`, check);
  for (const sequence of buckets.sequences) index.sequences.set(sequence.name, sequence);
  return index;
}

/** Rewrites every reference to a renamed table in the previous snapshot. */
function renameTableInIndex(index: EntityIndex, oldName: string, newName: string): void {
  const remap = (name: string): string => (name === oldName ? newName : name);
  const table = index.tables.get(oldName);
  if (table) {
    index.tables.delete(oldName);
    index.tables.set(newName, {
      ...table,
      name: newName,
      interleave: table.interleave && {
        ...table.interleave,
        parent: remap(table.interleave.parent),
      },
    });
  }
  for (const [name, entity] of index.tables) {
    if (entity.interleave && entity.interleave.parent === oldName) {
      index.tables.set(name, {
        ...entity,
        interleave: { ...entity.interleave, parent: newName },
      });
    }
  }
  const tableColumns = index.columns.get(oldName);
  if (tableColumns) {
    index.columns.delete(oldName);
    index.columns.set(
      newName,
      new Map([...tableColumns].map(([name, column]) => [name, { ...column, table: newName }])),
    );
  }
  const pk = index.pks.get(oldName);
  if (pk) {
    index.pks.delete(oldName);
    index.pks.set(newName, { ...pk, table: newName });
  }
  for (const [name, entity] of index.indexes) {
    if (entity.table === oldName) index.indexes.set(name, { ...entity, table: newName });
  }
  for (const [key, entity] of [...index.fks]) {
    if (entity.table === oldName || entity.foreignTable === oldName) {
      index.fks.delete(key);
      const renamed = {
        ...entity,
        table: remap(entity.table),
        foreignTable: remap(entity.foreignTable),
      };
      index.fks.set(`${renamed.table}.${renamed.name}`, renamed);
    }
  }
  for (const [key, entity] of [...index.checks]) {
    if (entity.table === oldName) {
      index.checks.delete(key);
      index.checks.set(`${newName}.${entity.name}`, { ...entity, table: newName });
    }
  }
}

const ALTERABLE_TYPE = /^(ARRAY<)?(STRING|BYTES)\((\d+|MAX)\)>?$/;

/** Spanner allows length changes and STRING<->BYTES coercion; nothing else. */
function typeChangeAllowed(from: string, to: string): boolean {
  const fromMatch = ALTERABLE_TYPE.exec(from);
  const toMatch = ALTERABLE_TYPE.exec(to);
  return fromMatch !== null && toMatch !== null && fromMatch[1] === toMatch[1];
}

interface StatementBuckets {
  renames: string[];
  dropIndexes: string[];
  dropConstraints: string[];
  dropColumns: string[];
  dropTables: string[];
  dropSequences: string[];
  createSequences: string[];
  createTables: string[];
  addColumns: string[];
  alterColumns: string[];
  createIndexes: string[];
  addConstraints: string[];
}

function flattenBuckets(buckets: StatementBuckets): string[] {
  return [
    ...buckets.renames,
    ...buckets.dropIndexes,
    ...buckets.dropConstraints,
    ...buckets.dropColumns,
    ...buckets.dropTables,
    ...buckets.dropSequences,
    ...buckets.createSequences,
    ...buckets.createTables,
    ...buckets.addColumns,
    ...buckets.alterColumns,
    ...buckets.createIndexes,
    ...buckets.addConstraints,
  ];
}

function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const MANUAL_TABLE_PATH =
  'Manual path: create a new table with the desired shape, backfill it, then swap reads and writes over and drop the old table.';
const MANUAL_COLUMN_PATH =
  'Manual path: add a new column, backfill it, then swap usages and drop the old column.';

/**
 * Diffs two snapshot entity lists into ordered GoogleSQL DDL statements.
 * Refuses diffs that need DDL Spanner does not have (primary-key changes,
 * interleave changes, disallowed type changes, generated-column changes,
 * column renames) by throwing `DiffRefusedError` — never a silent
 * DROP+CREATE (spec: irreversible DDL).
 */
export async function diffSnapshots(
  prevDdl: SpannerEntity[],
  curDdl: SpannerEntity[],
  options: DiffOptions = {},
): Promise<DiffResult> {
  const prev = indexEntities(prevDdl);
  const cur = indexEntities(curDdl);
  const diagnostics: DiffDiagnostic[] = [];
  const renamesJournal: ResolvedRename[] = [];
  const buckets: StatementBuckets = {
    renames: [],
    dropIndexes: [],
    dropConstraints: [],
    dropColumns: [],
    dropTables: [],
    dropSequences: [],
    createSequences: [],
    createTables: [],
    addColumns: [],
    alterColumns: [],
    createIndexes: [],
    addConstraints: [],
  };

  const resolveCandidate = async (candidate: RenameCandidate): Promise<string | null> => {
    if (options.resolveRename) return options.resolveRename(candidate);
    if (options.acceptDrops) return null;
    const scope =
      candidate.kind === 'table'
        ? `table "${candidate.dropped}"`
        : `column "${candidate.dropped}" of "${candidate.table}"`;
    diagnostics.push({
      kind: 'ambiguous-rename',
      table: candidate.table ?? candidate.dropped,
      column: candidate.kind === 'column' ? candidate.dropped : undefined,
      message: `Dropped ${scope} has created candidates (${candidate.created.join(
        ', ',
      )}) that may be renames. Run interactively to resolve them, or pass --accept-drops to treat them as drop+create.`,
    });
    return null;
  };

  // Table renames first: resolving one rewrites the previous snapshot so the
  // rest of the diff sees the renamed table as unchanged.
  const droppedTables = [...prev.tables.keys()].filter((name) => !cur.tables.has(name));
  let createdTableNames = [...cur.tables.keys()].filter((name) => !prev.tables.has(name));
  for (const dropped of droppedTables) {
    if (createdTableNames.length === 0) break;
    const chosen = await resolveCandidate({
      kind: 'table',
      dropped,
      created: createdTableNames,
    });
    if (chosen !== null) {
      if (!createdTableNames.includes(chosen)) {
        throw new Error(
          `drizzle-spanner-kit: rename target "${chosen}" is not a created table (candidates: ${createdTableNames.join(', ')})`,
        );
      }
      buckets.renames.push(renameTableSql(dropped, chosen));
      renamesJournal.push({ from: dropped, to: chosen });
      renameTableInIndex(prev, dropped, chosen);
      createdTableNames = createdTableNames.filter((name) => name !== chosen);
    }
  }

  // Sequences.
  for (const [name] of prev.sequences) {
    if (!cur.sequences.has(name)) buckets.dropSequences.push(dropSequenceSql(name));
  }
  for (const [name, sequence] of cur.sequences) {
    if (!prev.sequences.has(name)) buckets.createSequences.push(createSequenceSql(sequence));
  }

  // Dropped tables: their indexes go first, children before parents.
  const stillDropped = [...prev.tables.values()].filter((table) => !cur.tables.has(table.name));
  const droppedNames = new Set(stillDropped.map((table) => table.name));
  for (const index of prev.indexes.values()) {
    if (droppedNames.has(index.table)) buckets.dropIndexes.push(dropIndexSql(index.name));
  }
  const fksOfDropped = groupByTable(
    [...prev.fks.values()].filter((fk) => droppedNames.has(fk.table)),
  );
  buckets.dropTables.push(
    ...orderTablesParentsFirst(stillDropped, fksOfDropped)
      .reverse()
      .map((table) => dropTableSql(table.name)),
  );

  // Created tables: parents before interleaved children and FK targets.
  const createdTables = [...cur.tables.values()].filter((table) => !prev.tables.has(table.name));
  const createdNames = new Set(createdTables.map((table) => table.name));
  const curFksByTable = groupByTable([...cur.fks.values()]);
  for (const table of orderTablesParentsFirst(createdTables, curFksByTable)) {
    const pk = cur.pks.get(table.name);
    if (!pk) {
      throw new Error(`drizzle-spanner-kit: snapshot has no primary key for "${table.name}"`);
    }
    buckets.createTables.push(
      createTableSql(
        table,
        [...(cur.columns.get(table.name)?.values() ?? [])],
        pk,
        curFksByTable.get(table.name) ?? [],
        [...cur.checks.values()].filter((check) => check.table === table.name),
      ),
    );
    for (const index of cur.indexes.values()) {
      if (index.table === table.name) buckets.createIndexes.push(createIndexSql(index));
    }
  }

  // Tables present on both sides.
  for (const [tableName, curTable] of cur.tables) {
    const prevTable = prev.tables.get(tableName);
    if (!prevTable) continue;

    if (!equalJson(prevTable.interleave, curTable.interleave)) {
      diagnostics.push({
        kind: 'interleave-change',
        table: tableName,
        message: `The interleaving of "${tableName}" changed (${JSON.stringify(
          prevTable.interleave,
        )} -> ${JSON.stringify(
          curTable.interleave,
        )}). Spanner cannot change a table's interleaving after creation. ${MANUAL_TABLE_PATH}`,
      });
    }

    const prevPk = prev.pks.get(tableName);
    const curPk = cur.pks.get(tableName);
    if (prevPk && curPk && !equalJson(prevPk.columns, curPk.columns)) {
      diagnostics.push({
        kind: 'primary-key-change',
        table: tableName,
        message: `The primary key of "${tableName}" changed (${JSON.stringify(
          prevPk.columns,
        )} -> ${JSON.stringify(
          curPk.columns,
        )}). Spanner cannot alter a table's primary key. ${MANUAL_TABLE_PATH}`,
      });
    }

    const prevColumns = prev.columns.get(tableName) ?? new Map<string, ColumnEntity>();
    const curColumns = cur.columns.get(tableName) ?? new Map<string, ColumnEntity>();

    // Column rename candidates: dropped column with a created column of the
    // same type. Spanner has no RENAME COLUMN, so a confirmed rename is
    // refused with the manual path.
    const droppedColumns = [...prevColumns.values()].filter(
      (column) => !curColumns.has(column.name),
    );
    const createdColumns = [...curColumns.values()].filter(
      (column) => !prevColumns.has(column.name),
    );
    const resolvedRenames = new Set<string>();
    for (const dropped of droppedColumns) {
      const candidates = createdColumns
        .filter((column) => column.type === dropped.type && !resolvedRenames.has(column.name))
        .map((column) => column.name);
      if (candidates.length === 0) continue;
      const chosen = await resolveCandidate({
        kind: 'column',
        table: tableName,
        dropped: dropped.name,
        created: candidates,
      });
      if (chosen !== null) {
        resolvedRenames.add(chosen);
        renamesJournal.push({
          from: `${tableName}.${dropped.name}`,
          to: `${tableName}.${chosen}`,
        });
        diagnostics.push({
          kind: 'column-rename',
          table: tableName,
          column: dropped.name,
          message: `Column "${dropped.name}" of "${tableName}" was renamed to "${chosen}", but Spanner has no RENAME COLUMN. ${MANUAL_COLUMN_PATH}`,
        });
      }
    }

    for (const column of droppedColumns) {
      buckets.dropColumns.push(dropColumnSql(tableName, column.name));
    }
    for (const column of createdColumns) {
      buckets.addColumns.push(addColumnSql(column));
    }

    for (const [columnName, curColumn] of curColumns) {
      const prevColumn = prevColumns.get(columnName);
      if (!prevColumn || equalJson(prevColumn, curColumn)) continue;

      if (
        !equalJson(prevColumn.generated, curColumn.generated) ||
        prevColumn.generatedIdentity !== curColumn.generatedIdentity
      ) {
        diagnostics.push({
          kind: 'generated-column-change',
          table: tableName,
          column: columnName,
          message: `The generated/identity definition of column "${columnName}" of "${tableName}" changed; Spanner cannot alter it. ${MANUAL_COLUMN_PATH}`,
        });
        continue;
      }
      if (prevColumn.type !== curColumn.type && !typeChangeAllowed(prevColumn.type, curColumn.type)) {
        diagnostics.push({
          kind: 'column-type-change',
          table: tableName,
          column: columnName,
          message: `Spanner cannot change column "${columnName}" of "${tableName}" from ${prevColumn.type} to ${curColumn.type} (only STRING/BYTES length changes and STRING<->BYTES are alterable). ${MANUAL_COLUMN_PATH}`,
        });
        continue;
      }
      if (prevColumn.type !== curColumn.type || prevColumn.notNull !== curColumn.notNull) {
        buckets.alterColumns.push(alterColumnTypeSql(curColumn));
      }
      if (prevColumn.default !== curColumn.default) {
        buckets.alterColumns.push(alterColumnDefaultSql(curColumn));
      }
      if (prevColumn.allowCommitTimestamp !== curColumn.allowCommitTimestamp) {
        buckets.alterColumns.push(alterColumnCommitTimestampSql(curColumn));
      }
    }
  }

  // Indexes on surviving tables (created-table indexes were emitted above).
  for (const [name, prevIndex] of prev.indexes) {
    if (droppedNames.has(prevIndex.table)) continue;
    const curIndex = cur.indexes.get(name);
    if (!curIndex) {
      buckets.dropIndexes.push(dropIndexSql(name));
    } else if (!equalJson(prevIndex, curIndex)) {
      buckets.dropIndexes.push(dropIndexSql(name));
      buckets.createIndexes.push(createIndexSql(curIndex));
    }
  }
  for (const [name, curIndex] of cur.indexes) {
    if (!prev.indexes.has(name) && !createdNames.has(curIndex.table)) {
      buckets.createIndexes.push(createIndexSql(curIndex));
    }
  }

  // Foreign keys and checks on surviving tables.
  for (const [key, prevFk] of prev.fks) {
    if (droppedNames.has(prevFk.table)) continue;
    const curFk = cur.fks.get(key);
    if (!curFk || !equalJson(prevFk, curFk)) {
      buckets.dropConstraints.push(dropConstraintSql(prevFk.table, prevFk.name));
    }
  }
  for (const [key, curFk] of cur.fks) {
    if (createdNames.has(curFk.table)) continue;
    const prevFk = prev.fks.get(key);
    if (!prevFk || !equalJson(prevFk, curFk)) {
      buckets.addConstraints.push(addConstraintSql(curFk.table, foreignKeyConstraintSql(curFk)));
    }
  }
  for (const [key, prevCheck] of prev.checks) {
    if (droppedNames.has(prevCheck.table)) continue;
    const curCheck = cur.checks.get(key);
    if (!curCheck || !equalJson(prevCheck, curCheck)) {
      buckets.dropConstraints.push(dropConstraintSql(prevCheck.table, prevCheck.name));
    }
  }
  for (const [key, curCheck] of cur.checks) {
    if (createdNames.has(curCheck.table)) continue;
    const prevCheck = prev.checks.get(key);
    if (!prevCheck || !equalJson(prevCheck, curCheck)) {
      buckets.addConstraints.push(addConstraintSql(curCheck.table, checkConstraintSql(curCheck)));
    }
  }

  if (diagnostics.length > 0) throw new DiffRefusedError(diagnostics);
  return { statements: flattenBuckets(buckets), renames: renamesJournal };
}
