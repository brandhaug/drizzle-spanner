import { type ColumnBuilderBase } from 'drizzle-orm/column-builder'
import { entityKind, is } from 'drizzle-orm/entity'
import {
  type InferTableColumnsModels,
  type TableConfig as TableConfigBase
} from 'drizzle-orm/table'
import { Table } from 'drizzle-orm/table'
import {
  type BuildSpannerColumns,
  type BuildSpannerExtraConfigColumns,
  type SpannerColumn,
  type SpannerColumnBuilder,
  type SpannerExtraConfigColumn
} from './columns/common.js'
import { type CheckBuilder } from './checks.js'
import { type ForeignKeyBuilder } from './foreign-keys.js'
import { type IndexBuilder } from './indexes.js'
import { InterleaveBuilder } from './interleave.js'
import { type AdmissiblePkOrder } from './interleave.js'
import { PrimaryKeyBuilder } from './primary-keys.js'
import {
  ExtraConfigBuilder,
  ExtraConfigColumns,
  TableColumns,
  TableName
} from './symbols.js'

export type SpannerColumns = Record<string, SpannerColumn<any>>

export interface TableConfig extends TableConfigBase {
  columns: SpannerColumns
  dialect: 'spanner'
}

export class SpannerTable<T extends TableConfig = TableConfig> extends Table<T> {
  static readonly [entityKind]: string = 'SpannerTable'

  /** @internal */
  declare [TableName]: string
  /** @internal */
  declare [TableColumns]: SpannerColumns
  /** @internal */
  declare [ExtraConfigColumns]: Record<string, SpannerExtraConfigColumn>
  /** @internal */
  declare [ExtraConfigBuilder]:
    | ((
        self: Record<string, SpannerExtraConfigColumn>
      ) => SpannerTableExtraConfigValue[])
    | undefined
}

export type SpannerTableExtraConfigValue =
  | IndexBuilder
  | PrimaryKeyBuilder
  | InterleaveBuilder
  | ForeignKeyBuilder
  | CheckBuilder

type ColumnsDataOf<TColumnsMap extends Record<string, ColumnBuilderBase>> = {
  [Key in keyof TColumnsMap]: TColumnsMap[Key]['_']['data']
}

/**
 * The extra-config union, parameterized so an `interleaveInParent` entry
 * type-checks that this table declares every type-visible parent primary-key
 * column with a matching data type, and — where `TEntries`, the union of the
 * other entries, carries a type-visible key order — declares them in the
 * parent's key order.
 */
export type SpannerTableExtraConfigValueFor<
  TColumnsMap extends Record<string, ColumnBuilderBase>,
  TEntries = never
> =
  | IndexBuilder
  | PrimaryKeyBuilder
  | InterleaveBuilder<ColumnsDataOf<TColumnsMap>, AdmissiblePkOrder<TEntries>>
  | ForeignKeyBuilder
  | CheckBuilder

export type SpannerTableWithColumns<T extends TableConfig> = SpannerTable<T> &
  T['columns'] &
  InferTableColumnsModels<T['columns']>

export type AnySpannerTable = SpannerTable

/**
 * Primary-key columns of a table in key order: a composite
 * `primaryKey({ columns })` entry wins, else the `.primaryKey()` columns in
 * declaration order. Key order matters — Spanner mutations address rows by it.
 */
export function getPrimaryKeyColumns(table: SpannerTable): SpannerColumn<any>[] {
  const columns = table[TableColumns]
  const extraConfigBuilder = table[ExtraConfigBuilder]
  if (extraConfigBuilder) {
    for (const entry of extraConfigBuilder(table[ExtraConfigColumns])) {
      if (is(entry, PrimaryKeyBuilder)) {
        // Composite keys capture SpannerExtraConfigColumn facades; map back
        // to the real columns by name.
        return entry.columns.map((column) =>
          Object.values(columns).find((candidate) => candidate.name === column.name)!
        )
      }
    }
  }
  return Object.values(columns).filter((column) => column.primary)
}

/**
 * Extra-config entries of a table (indexes, composite primary key,
 * interleaving, foreign keys, checks). Public read surface for
 * drizzle-spanner-kit's serializer.
 */
export function getTableExtraConfig(
  table: SpannerTable
): SpannerTableExtraConfigValue[] {
  const builder = table[ExtraConfigBuilder]
  return builder ? builder(table[ExtraConfigColumns]) : []
}

function primaryKeyColumnNames(table: SpannerTable): string[] {
  return getPrimaryKeyColumns(table).map((column) => column.name)
}

/**
 * The child primary key must start with the full parent primary key, in
 * order (Spanner DDL rule for `INTERLEAVE IN PARENT`). The types check the
 * cases they can see; this validates the full name-order rule, including
 * composite keys declared through `primaryKey({ columns })`.
 */
function validateInterleavePrefix(
  child: SpannerTable,
  interleave: InterleaveBuilder
): void {
  const parentPk = primaryKeyColumnNames(interleave.parent)
  const childPk = primaryKeyColumnNames(child)
  const parentName = interleave.parent[TableName]
  const childName = child[TableName]
  if (parentPk.length === 0) {
    throw new Error(
      `interleaveInParent: parent table "${parentName}" declares no primary key`
    )
  }
  const prefix = childPk.slice(0, parentPk.length)
  if (parentPk.some((name, i) => prefix[i] !== name)) {
    throw new Error(
      `interleaveInParent: primary key of "${childName}" (${childPk.join(', ') || 'none'}) must start with the primary key of parent "${parentName}" (${parentPk.join(', ')})`
    )
  }
}

/**
 * `TExtraConfig` is inferred from the entries the callback returns and fed back
 * into their own element constraint, which is what lets an `interleaveInParent`
 * entry check itself against the `primaryKey({ columns })` entry beside it.
 */
export function spannerTable<
  TTableName extends string,
  TColumnsMap extends Record<string, ColumnBuilderBase>,
  TExtraConfig extends readonly SpannerTableExtraConfigValueFor<
    TColumnsMap,
    TExtraConfig[number]
  >[]
>(
  name: TTableName,
  columns: TColumnsMap,
  extraConfig?: (self: BuildSpannerExtraConfigColumns<TColumnsMap>) => TExtraConfig
): SpannerTableWithColumns<{
  name: TTableName
  schema: undefined
  columns: BuildSpannerColumns<TTableName, TColumnsMap>
  dialect: 'spanner'
}> {
  const rawTable = new SpannerTable(name, undefined, name)

  const builtColumns: SpannerColumns = {}
  const builtExtraConfigColumns: Record<string, SpannerExtraConfigColumn> = {}
  for (const [columnName, columnBuilderBase] of Object.entries(columns)) {
    const columnBuilder = columnBuilderBase as SpannerColumnBuilder
    columnBuilder.setName(columnName)
    builtColumns[columnName] = columnBuilder.build(rawTable)
    builtExtraConfigColumns[columnName] = columnBuilder.buildExtraConfigColumn(rawTable)
  }

  const table = Object.assign(rawTable, builtColumns)
  table[TableColumns] = builtColumns
  table[ExtraConfigColumns] = builtExtraConfigColumns

  if (extraConfig) {
    // The declared parameter is keyed on `TColumnsMap`, so the widened
    // `Record` form of the callback is only reachable through `unknown`.
    table[ExtraConfigBuilder] = extraConfig as unknown as (
      self: Record<string, SpannerExtraConfigColumn>
    ) => SpannerTableExtraConfigValue[]
    for (const entry of extraConfig(
      builtExtraConfigColumns as BuildSpannerExtraConfigColumns<TColumnsMap>
    )) {
      if (is(entry, InterleaveBuilder)) validateInterleavePrefix(table, entry)
    }
  }

  return table as unknown as SpannerTableWithColumns<{
    name: TTableName
    schema: undefined
    columns: BuildSpannerColumns<TTableName, TColumnsMap>
    dialect: 'spanner'
  }>
}
