import type { ColumnBuilderBase } from 'drizzle-orm/column-builder';
import { entityKind, is } from 'drizzle-orm/entity';
import type { InferTableColumnsModels, TableConfig as TableConfigBase } from 'drizzle-orm/table';
import { Table } from 'drizzle-orm/table';
import type {
  BuildSpannerColumns,
  BuildSpannerExtraConfigColumns,
  SpannerColumn,
  SpannerExtraConfigColumn,
} from './columns/common.js';
import { SpannerColumnBuilder } from './columns/common.js';
import type { IndexBuilder } from './indexes.js';
import { InterleaveBuilder } from './interleave.js';
import { PrimaryKeyBuilder } from './primary-keys.js';
import { ExtraConfigBuilder, ExtraConfigColumns, TableColumns, TableName } from './symbols.js';

export type SpannerColumns = Record<string, SpannerColumn<any>>;

export interface TableConfig extends TableConfigBase {
  columns: SpannerColumns;
  dialect: 'spanner';
}

export class SpannerTable<T extends TableConfig = TableConfig> extends Table<T> {
  static readonly [entityKind]: string = 'SpannerTable';

  /** @internal */
  declare [TableName]: string;
  /** @internal */
  declare [TableColumns]: SpannerColumns;
  /** @internal */
  declare [ExtraConfigColumns]: Record<string, SpannerExtraConfigColumn>;
  /** @internal */
  declare [ExtraConfigBuilder]:
    | ((self: Record<string, SpannerExtraConfigColumn>) => SpannerTableExtraConfigValue[])
    | undefined;
}

export type SpannerTableExtraConfigValue =
  | IndexBuilder
  | PrimaryKeyBuilder
  | InterleaveBuilder<any>;

type ColumnsDataOf<TColumnsMap extends Record<string, ColumnBuilderBase>> = {
  [Key in keyof TColumnsMap]: TColumnsMap[Key]['_']['data'];
};

/**
 * The extra-config union, parameterized so an `interleaveInParent` entry
 * type-checks that this table declares every type-visible parent primary-key
 * column with a matching data type.
 */
export type SpannerTableExtraConfigValueFor<
  TColumnsMap extends Record<string, ColumnBuilderBase>,
> = IndexBuilder | PrimaryKeyBuilder | InterleaveBuilder<ColumnsDataOf<TColumnsMap>>;

export type SpannerTableWithColumns<T extends TableConfig> = SpannerTable<T> &
  T['columns'] &
  InferTableColumnsModels<T['columns']>;

export type AnySpannerTable = SpannerTable<TableConfig>;

function primaryKeyColumnNames(table: SpannerTable): string[] {
  const extraConfigBuilder = table[ExtraConfigBuilder];
  if (extraConfigBuilder) {
    for (const entry of extraConfigBuilder(table[ExtraConfigColumns])) {
      if (is(entry, PrimaryKeyBuilder)) {
        return entry.columns.map((column) => column.name);
      }
    }
  }
  return Object.values(table[TableColumns])
    .filter((column) => column.primary)
    .map((column) => column.name);
}

/**
 * The child primary key must start with the full parent primary key, in
 * order (Spanner DDL rule for `INTERLEAVE IN PARENT`). The types check the
 * cases they can see; this validates the full name-order rule, including
 * composite keys declared through `primaryKey({ columns })`.
 */
function validateInterleavePrefix(child: SpannerTable, interleave: InterleaveBuilder): void {
  const parentPk = primaryKeyColumnNames(interleave.parent);
  const childPk = primaryKeyColumnNames(child);
  const parentName = interleave.parent[TableName];
  const childName = child[TableName];
  if (parentPk.length === 0) {
    throw new Error(`interleaveInParent: parent table "${parentName}" declares no primary key`);
  }
  const prefix = childPk.slice(0, parentPk.length);
  if (parentPk.some((name, i) => prefix[i] !== name)) {
    throw new Error(
      `interleaveInParent: primary key of "${childName}" (${childPk.join(', ') || 'none'}) must start with the primary key of parent "${parentName}" (${parentPk.join(', ')})`,
    );
  }
}

export function spannerTable<
  TTableName extends string,
  TColumnsMap extends Record<string, ColumnBuilderBase>,
>(
  name: TTableName,
  columns: TColumnsMap,
  extraConfig?: (
    self: BuildSpannerExtraConfigColumns<TColumnsMap>,
  ) => SpannerTableExtraConfigValueFor<TColumnsMap>[],
): SpannerTableWithColumns<{
  name: TTableName;
  schema: undefined;
  columns: BuildSpannerColumns<TTableName, TColumnsMap>;
  dialect: 'spanner';
}> {
  const rawTable = new SpannerTable(name, undefined, name);

  const builtColumns: SpannerColumns = {};
  const builtExtraConfigColumns: Record<string, SpannerExtraConfigColumn> = {};
  for (const [columnName, columnBuilderBase] of Object.entries(columns)) {
    const columnBuilder = columnBuilderBase as SpannerColumnBuilder;
    columnBuilder.setName(columnName);
    builtColumns[columnName] = columnBuilder.build(rawTable);
    builtExtraConfigColumns[columnName] = columnBuilder.buildExtraConfigColumn(rawTable);
  }

  const table = Object.assign(rawTable, builtColumns);
  table[TableColumns] = builtColumns;
  table[ExtraConfigColumns] = builtExtraConfigColumns;

  if (extraConfig) {
    table[ExtraConfigBuilder] = extraConfig as unknown as (
      self: Record<string, SpannerExtraConfigColumn>,
    ) => SpannerTableExtraConfigValue[];
    for (const entry of extraConfig(
      builtExtraConfigColumns as BuildSpannerExtraConfigColumns<TColumnsMap>,
    )) {
      if (is(entry, InterleaveBuilder)) validateInterleavePrefix(table, entry);
    }
  }

  return table as unknown as SpannerTableWithColumns<{
    name: TTableName;
    schema: undefined;
    columns: BuildSpannerColumns<TTableName, TColumnsMap>;
    dialect: 'spanner';
  }>;
}
