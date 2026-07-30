import { is } from 'drizzle-orm/entity';
import { SQL } from 'drizzle-orm/sql';
import { getTableName } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';
import {
  CheckBuilder,
  ForeignKeyBuilder,
  IndexBuilder,
  IndexedColumn,
  InterleaveBuilder,
  PrimaryKeyBuilder,
  SpannerDialect,
  SpannerSequence,
  SpannerTable,
  SpannerTimestamp,
} from 'drizzle-spanner';
import { getTableExtraConfig } from 'drizzle-spanner/internal';
import type { SpannerColumn, SpannerExtraConfigColumn } from 'drizzle-spanner';
import type {
  ColumnEntity,
  ForeignKeyEntity,
  IndexEntity,
  KeyPart,
  PrimaryKeyEntity,
  SpannerEntity,
  TableEntity,
} from './snapshot.js';

const dialect = new SpannerDialect();

/**
 * Renders an SQL expression to DDL text: bare column names (no table
 * qualification) and inlined parameter values.
 */
function renderSql(expression: SQL): string {
  return dialect.sqlToQuery(expression.inlineParams(), 'indexes').sql;
}

/** Renders a plain JS default value as a GoogleSQL literal. */
function renderLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `TIMESTAMP '${value.toISOString()}'`;
  if (Array.isArray(value)) return `[${value.map(renderLiteral).join(', ')}]`;
  throw new Error(
    `drizzle-spanner-kit: cannot render default value ${String(value)} as a DDL literal`,
  );
}

function renderDefault(value: unknown): string {
  return is(value, SQL) ? renderSql(value) : renderLiteral(value);
}

function renderGenerated(column: SpannerColumn<any>): ColumnEntity['generated'] {
  const generated = column.generated;
  if (!generated) return null;
  const asValue = typeof generated.as === 'function' ? generated.as() : generated.as;
  return {
    as: is(asValue, SQL) ? renderSql(asValue) : renderLiteral(asValue),
    // Spanner generated columns are STORED unless declared virtual.
    stored: (generated.mode ?? 'stored') === 'stored',
  };
}

function serializeColumn(tableName: string, column: SpannerColumn<any>): ColumnEntity {
  return {
    entityType: 'columns',
    table: tableName,
    name: column.name,
    type: column.getSQLType(),
    notNull: column.notNull,
    default: column.default === undefined ? null : renderDefault(column.default),
    generated: renderGenerated(column),
    generatedIdentity: column.generatedIdentity !== undefined,
    allowCommitTimestamp: is(column, SpannerTimestamp) && column.allowCommitTimestamp,
  };
}

function facadeKeyPart(column: SpannerExtraConfigColumn): KeyPart {
  return { name: column.name, order: column.indexConfig.order };
}

function serializePrimaryKey(
  tableName: string,
  table: SpannerTable,
  extraConfig: ReturnType<typeof getTableExtraConfig>,
): PrimaryKeyEntity {
  for (const entry of extraConfig) {
    if (is(entry, PrimaryKeyBuilder)) {
      return {
        entityType: 'pks',
        table: tableName,
        columns: entry.columns.map(facadeKeyPart),
      };
    }
  }
  const columns = Object.values(getTableColumns(table) as Record<string, SpannerColumn<any>>)
    .filter((column) => column.primary)
    .map((column): KeyPart => ({ name: column.name, order: 'asc' }));
  if (columns.length === 0) {
    throw new Error(
      `drizzle-spanner-kit: table "${tableName}" has no primary key; Spanner requires one on every table`,
    );
  }
  return { entityType: 'pks', table: tableName, columns };
}

function serializeIndex(tableName: string, builder: IndexBuilder): IndexEntity {
  const { name, columns, unique, nullFiltered, storing } = builder.config;
  return {
    entityType: 'indexes',
    table: tableName,
    name,
    columns: columns.map((column) => {
      if (!is(column, IndexedColumn)) {
        throw new Error(
          `drizzle-spanner-kit: index "${name}" on "${tableName}" uses an SQL expression; Spanner indexes key on columns only (index a generated column instead)`,
        );
      }
      return { name: column.name, order: column.order };
    }),
    unique,
    nullFiltered,
    storing: storing.map((column) => column.name),
  };
}

function serializeForeignKey(tableName: string, builder: ForeignKeyBuilder): ForeignKeyEntity {
  const { name, columns, foreignColumns, foreignTable, onDelete } = builder.config;
  const columnNames = columns.map((column) => column.name);
  return {
    entityType: 'fks',
    table: tableName,
    name: name ?? `fk_${tableName}_${columnNames.join('_')}`,
    columns: columnNames,
    foreignTable: getTableName(foreignTable),
    foreignColumns: foreignColumns.map((column) => column.name),
    onDelete,
  };
}

function serializeTable(table: SpannerTable): SpannerEntity[] {
  const tableName = getTableName(table);
  const extraConfig = getTableExtraConfig(table);

  const entities: SpannerEntity[] = [];
  let interleaveConfig: TableEntity['interleave'] = null;

  const indexes: SpannerEntity[] = [];
  const fks: SpannerEntity[] = [];
  const checks: SpannerEntity[] = [];
  for (const entry of extraConfig) {
    if (is(entry, InterleaveBuilder)) {
      interleaveConfig = {
        parent: getTableName(entry.parent),
        onDelete: entry.config.onDelete ?? 'noAction',
      };
    } else if (is(entry, IndexBuilder)) {
      indexes.push(serializeIndex(tableName, entry));
    } else if (is(entry, ForeignKeyBuilder)) {
      fks.push(serializeForeignKey(tableName, entry));
    } else if (is(entry, CheckBuilder)) {
      checks.push({
        entityType: 'checks',
        table: tableName,
        name: entry.name,
        value: renderSql(entry.value),
      });
    }
  }

  entities.push({ entityType: 'tables', name: tableName, interleave: interleaveConfig });
  for (const column of Object.values(getTableColumns(table) as Record<string, SpannerColumn<any>>)) {
    entities.push(serializeColumn(tableName, column));
  }
  entities.push(serializePrimaryKey(tableName, table, extraConfig));
  entities.push(...indexes, ...fks, ...checks);
  return entities;
}

/**
 * Walks a schema module's exports (`spannerTable` and `sequence` values;
 * anything else is ignored) into the flat snapshot entity list.
 */
export function serializeSchema(schemaExports: Record<string, unknown>): SpannerEntity[] {
  const entities: SpannerEntity[] = [];
  const seenTables = new Set<unknown>();
  const seenSequences = new Set<string>();
  for (const value of Object.values(schemaExports)) {
    if (is(value, SpannerTable)) {
      if (seenTables.has(value)) continue;
      seenTables.add(value);
      entities.push(...serializeTable(value));
    } else if (is(value, SpannerSequence)) {
      if (seenSequences.has(value.name)) continue;
      seenSequences.add(value.name);
      entities.push({ entityType: 'sequences', name: value.name, kind: 'bit_reversed_positive' });
    }
  }
  return entities;
}
