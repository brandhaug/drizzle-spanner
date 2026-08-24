import { aliasedTable } from 'drizzle-orm/alias'
import { entityKind, is } from 'drizzle-orm/entity'
import { DrizzleError } from 'drizzle-orm/errors'
import type {
  AnyRelations,
  BuildRelationalQueryResult,
  TableRelationalConfig
} from 'drizzle-orm/relations'
import {
  getTableAsAliasSQL,
  One,
  relationExtrasToSQL,
  relationsFilterToSQL,
  relationsOrderToSQL,
  relationToSQL
} from 'drizzle-orm/relations'
import type { DriverValueEncoder, Query, SQLChunk } from 'drizzle-orm/sql'
import { Column } from 'drizzle-orm/column'
import { and } from 'drizzle-orm/sql/expressions'
import { Param, Placeholder, SQL, sql } from 'drizzle-orm/sql'
import type { SelectedFieldsOrdered } from './orm-internal.js'
import { orderSelectedFields } from './orm-internal.js'
import { SpannerColumn } from './columns/common.js'
import type { SpannerTable } from './table.js'
import { TableColumns } from './symbols.js'

export interface SpannerSelectConfig {
  table: SpannerTable | SQL
  fields: Record<string, unknown>
  fieldsFlat?: SelectedFieldsOrdered
  where?: SQL
  orderBy?: (SpannerColumn<any> | SQL)[]
  limit?: number | SQL
  offset?: number | SQL
}

export interface SpannerInsertConfig {
  table: SpannerTable
  values: Record<string, Param | SQL>[]
  returning?: SelectedFieldsOrdered
  /** `INSERT OR UPDATE` / `INSERT OR IGNORE` (ADR 0002) — Spanner's upsert forms. */
  conflictAction?: 'update' | 'ignore'
}

export interface SpannerUpdateConfig {
  table: SpannerTable
  set: Record<string, Param | SQL>
  where?: SQL
  returning?: SelectedFieldsOrdered
}

export interface SpannerDeleteConfig {
  table: SpannerTable
  where?: SQL
  returning?: SelectedFieldsOrdered
}

/**
 * `Query` plus Spanner-specific parameter metadata gathered while compiling:
 * the type hint for each positional parameter and the column name behind it,
 * so the session can build driver `types` entries and error hints can name the
 * column a failing parameter binds.
 */
export interface SpannerQueryWithTypings extends Query {
  typings?: string[]
  paramColumns?: (string | undefined)[]
}

export class SpannerDialect {
  static readonly [entityKind]: string = 'SpannerDialect'

  escapeName(name: string): string {
    return `\`${name}\``
  }

  escapeParam(num: number, _value: unknown): string {
    return `@p${num}`
  }

  escapeString(str: string): string {
    return `'${str.replace(/'/g, "\\'")}'`
  }

  /**
   * The type hint each column emits; since rc.4 drizzle no longer carries a
   * `typings` channel on `Query`, so hints are collected by walking the SQL
   * tree in parameter-emission order and ride on `SpannerQueryWithTypings`.
   */
  prepareTyping = (encoder: DriverValueEncoder<unknown, unknown>): string => {
    if (is(encoder, SpannerColumn)) {
      return encoder.typeHint()
    }
    return 'none'
  }

  /**
   * Walks the SQL tree in the same pre-order `SQL.toQuery` emits parameters,
   * recording each parameter's type hint and source column.
   */
  private collectParamInfo(
    sqlInput: SQL,
    typings: string[],
    paramColumns: (string | undefined)[]
  ): void {
    const walk = (chunk: unknown): void => {
      if (chunk === undefined) return
      if (Array.isArray(chunk)) {
        chunk.forEach(walk)
        return
      }
      if (chunk instanceof Param) {
        if (is(chunk.value, SQL)) {
          // Params wrapping SQL expand into the inner statement's params.
          walk(chunk.value)
          return
        }
        if (is(chunk.encoder, SpannerColumn)) {
          typings.push(this.prepareTyping(chunk.encoder))
          paramColumns.push(chunk.encoder.name)
        } else {
          typings.push('none')
          paramColumns.push(undefined)
        }
        return
      }
      if (is(chunk, Placeholder)) {
        typings.push('none')
        paramColumns.push(undefined)
        return
      }
      if (is(chunk, SQL)) {
        chunk.queryChunks.forEach(walk)
        return
      }
      if (
        typeof chunk === 'string' ||
        typeof chunk === 'number' ||
        typeof chunk === 'boolean' ||
        typeof chunk === 'bigint' ||
        chunk === null
      ) {
        // Raw values in the sql tag become positional params.
        typings.push('none')
        paramColumns.push(undefined)
      }
      // Everything else (Name, Column, Table, SQL.Aliased, …) emits no params.
    }
    sqlInput.queryChunks.forEach(walk)
  }

  sqlToQuery(
    sqlInput: SQL,
    invokeSource?: 'indexes' | undefined
  ): SpannerQueryWithTypings {
    const query = sqlInput.toQuery({
      escapeName: this.escapeName,
      escapeParam: this.escapeParam,
      escapeString: this.escapeString,
      invokeSource
    })
    const typings: string[] = []
    const paramColumns: (string | undefined)[] = []
    this.collectParamInfo(sqlInput, typings, paramColumns)
    return { ...query, typings, paramColumns }
  }

  private buildSelection(fields: SelectedFieldsOrdered): SQL {
    const columnsLen = fields.length
    const chunks = fields.flatMap(({ field }, i) => {
      const chunk: SQLChunk[] = []
      if (is(field, SQL.Aliased)) {
        chunk.push(field.sql, sql` as ${sql.identifier(field.fieldAlias)}`)
      } else if (is(field, SQL) || is(field, Column)) {
        chunk.push(field)
      }
      if (i < columnsLen - 1) chunk.push(sql`, `)
      return chunk
    })
    return sql.join(chunks)
  }

  private buildReturning(
    returning: SelectedFieldsOrdered | undefined
  ): SQL | undefined {
    return returning ? sql` then return ${this.buildSelection(returning)}` : undefined
  }

  /** Spanner rejects UPDATE/DELETE without WHERE; `where true` affects all rows (ADR 0001). */
  private buildWhereOrTrue(where: SQL | undefined): SQL {
    return where ? sql` where ${where}` : sql` where true`
  }

  buildSelectQuery(config: SpannerSelectConfig): SQL {
    const { fields, fieldsFlat, where, table, orderBy, limit, offset } = config
    const fieldsList = fieldsFlat ?? orderSelectedFields(fields)
    const selection = this.buildSelection(fieldsList)
    const whereSql = where ? sql` where ${where}` : undefined
    const orderBySql =
      orderBy && orderBy.length > 0
        ? sql` order by ${sql.join(orderBy, sql`, `)}`
        : undefined
    const limitSql =
      typeof limit === 'number' || is(limit, SQL) ? sql` limit ${limit}` : undefined
    const offsetSql =
      typeof offset === 'number' || is(offset, SQL) ? sql` offset ${offset}` : undefined
    return sql`select ${selection} from ${table}${whereSql}${orderBySql}${limitSql}${offsetSql}`
  }

  buildInsertQuery(config: SpannerInsertConfig): SQL {
    const { table, values, returning, conflictAction } = config
    const columns = table[TableColumns]
    const colEntries = Object.entries(columns)
    const insertOrder = colEntries.map(([, column]) => sql.identifier(column.name))

    const valuesSqlList: (SQLChunk[] | SQL)[] = []
    for (const [valueIndex, value] of values.entries()) {
      const valueList: SQLChunk[] = []
      for (const [fieldName] of colEntries) {
        const colValue = value[fieldName]
        if (
          colValue === undefined ||
          (is(colValue, Param) && colValue.value === undefined)
        ) {
          valueList.push(sql`default`)
        } else {
          valueList.push(colValue)
        }
      }
      valuesSqlList.push(valueList)
      if (valueIndex < values.length - 1) valuesSqlList.push(sql`, `)
    }
    const valuesSql = sql.join(valuesSqlList)

    const returningSql = this.buildReturning(returning)
    const insertKeyword =
      conflictAction === undefined
        ? sql`insert`
        : sql.raw(`insert or ${conflictAction}`)
    return sql`${insertKeyword} into ${table} ${insertOrder} values ${valuesSql}${returningSql}`
  }

  buildUpdateSet(table: SpannerTable, set: Record<string, Param | SQL>): SQL {
    const tableColumns = table[TableColumns]
    const columnNames = Object.keys(tableColumns).filter(
      (columnName) => set[columnName] !== undefined
    )
    const setLength = columnNames.length
    return sql.join(
      columnNames.flatMap((columnName, i) => {
        const column = tableColumns[columnName]!
        const value = set[columnName]!
        const assignment = sql`${sql.identifier(column.name)} = ${value}`
        return i < setLength - 1 ? [assignment, sql.raw(', ')] : [assignment]
      })
    )
  }

  buildUpdateQuery(config: SpannerUpdateConfig): SQL {
    const { table, set, where, returning } = config
    const setSql = this.buildUpdateSet(table, set)
    return sql`update ${table} set ${setSql}${this.buildWhereOrTrue(where)}${this.buildReturning(returning)}`
  }

  buildDeleteQuery(config: SpannerDeleteConfig): SQL {
    const { table, where, returning } = config
    return sql`delete from ${table}${this.buildWhereOrTrue(where)}${this.buildReturning(returning)}`
  }

  buildCountQuery(table: SpannerTable | SQL, where?: SQL): SQL {
    const whereSql = where ? sql` where ${where}` : undefined
    return sql`select count(*) as ${sql.identifier('count')} from ${table}${whereSql}`
  }

  private buildRqbColumn(table: SpannerTable, column: unknown, key: string): SQL {
    if (is(column, Column)) {
      return sql`${table}.${sql.identifier(column.name)} as ${sql.identifier(key)}`
    }
    throw new DrizzleError({
      message: `Field "${key}" is not a column; the relational query builder selects table columns (use extras for SQL expressions)`
    })
  }

  /** Column list of one RQB level, honoring the `columns` include/exclude config. */
  private buildRqbColumns(
    table: SpannerTable,
    selection: BuildRelationalQueryResult['selection'],
    config?: SpannerRelationalQueryConfigEntry
  ): SQL | undefined {
    const columnContainer = table[TableColumns]
    const columnsConfig =
      config === true || config === undefined ? undefined : config.columns
    const columnIdentifiers: SQL[] = []
    const pushColumn = (key: string, column: SpannerColumn<any>): void => {
      columnIdentifiers.push(this.buildRqbColumn(table, column, key))
      selection.push({ key, field: column })
    }
    if (columnsConfig) {
      const entries = Object.entries(columnsConfig).filter(
        ([, value]) => value !== undefined
      )
      const included = entries.filter(([, value]) => value)
      if (included.length > 0) {
        for (const [key] of included) pushColumn(key, columnContainer[key]!)
      } else {
        // Exclusion mode: everything except the false keys.
        for (const [key, column] of Object.entries(columnContainer)) {
          if (columnsConfig[key] === false) continue
          pushColumn(key, column)
        }
      }
      return columnIdentifiers.length > 0
        ? sql.join(columnIdentifiers, sql`, `)
        : undefined
    }
    for (const [key, column] of Object.entries(columnContainer)) pushColumn(key, column)
    return sql.join(columnIdentifiers, sql`, `)
  }

  /**
   * Relational query compiler (spec: relational queries). Nested collections
   * become correlated `ARRAY(SELECT AS STRUCT ...)` subqueries and to-one
   * relations a scalar `(SELECT AS STRUCT ... LIMIT 1)` — one round trip,
   * decoded with full type fidelity through the driver's STRUCT values.
   */
  buildRelationalQuery(
    config: SpannerRelationalQueryInput
  ): BuildRelationalQueryResult {
    const { schema, tableConfig, queryConfig, relationWhere, mode, throughJoin } =
      config
    const selection: BuildRelationalQueryResult['selection'] = []
    const isSingle = mode === 'first'
    const params = queryConfig === true ? undefined : queryConfig
    const currentPath = config.errorPath ?? ''
    const currentDepth = config.depth ?? 0
    const table = currentDepth
      ? config.table
      : aliasedTable(config.table, `d${currentDepth}`)

    const limit = isSingle ? 1 : params?.limit
    const offset = params?.offset
    const filter = params?.where
      ? relationsFilterToSQL(table, params.where, tableConfig.relations, schema)
      : undefined
    const where =
      filter && relationWhere ? and(filter, relationWhere) : (filter ?? relationWhere)
    const order = params?.orderBy
      ? relationsOrderToSQL(table, params.orderBy)
      : undefined

    const columns = this.buildRqbColumns(table, selection, queryConfig)
    const extras = params?.extras
      ? // `as never`: drizzle types `extras` with the unexported DBQueryConfigExtras type.
        relationExtrasToSQL(table, params.extras as never)
      : undefined
    if (extras) selection.push(...extras.selection)

    const selectionArr: SQL[] = columns ? [columns] : []
    const withEntries = params?.with
      ? Object.entries(params.with as Record<string, unknown>).filter(
          ([, value]) => value
        )
      : []
    for (const [key, join] of withEntries) {
      const relation = tableConfig.relations[key]!
      const isSingleRelation = is(relation, One)
      const targetTable = aliasedTable(
        relation.targetTable,
        `d${currentDepth + 1}`
      ) as SpannerTable
      const throughTable = relation.throughTable
        ? (aliasedTable(relation.throughTable, `tr${currentDepth}`) as SpannerTable)
        : undefined
      const built = relationToSQL(relation, table, targetTable, throughTable)
      const innerThroughJoin = throughTable
        ? sql` inner join ${getTableAsAliasSQL(throughTable)} on ${built.joinCondition}`
        : undefined
      const innerQuery = this.buildRelationalQuery({
        schema,
        table: targetTable,
        tableConfig: schema[relation.targetTableName]!,
        queryConfig: join as SpannerRelationalQueryConfigEntry,
        relationWhere: built.filter,
        mode: isSingleRelation ? 'first' : 'many',
        errorPath: `${currentPath.length > 0 ? `${currentPath}.` : ''}${key}`,
        depth: currentDepth + 1,
        throughJoin: innerThroughJoin
      })
      selection.push({
        field: targetTable,
        key,
        selection: innerQuery.selection,
        isArray: !isSingleRelation,
        isOptional:
          ((relation as { optional?: boolean }).optional ?? false) ||
          (join !== true && !!(join as { where?: unknown }).where)
      })
      // Spanner cannot return a bare STRUCT as a column value, so to-one
      // relations also compile to ARRAY(...) (with LIMIT 1 from mode
      // 'first'); the decoder unwraps the single element.
      selectionArr.push(sql`array(${innerQuery.sql}) as ${sql.identifier(key)}`)
    }
    if (extras?.sql) selectionArr.push(extras.sql)
    if (selectionArr.length === 0) {
      throw new DrizzleError({
        message: `No fields selected for table "${tableConfig.name}"${currentPath ? ` ("${currentPath}")` : ''}`
      })
    }

    const selectKeyword = currentDepth ? sql`select as struct ` : sql`select `
    return {
      sql: sql`${selectKeyword}${sql.join(selectionArr, sql`, `)} from ${getTableAsAliasSQL(table)}${throughJoin}${sql` where ${where}`.if(where)}${sql` order by ${order}`.if(order)}${sql` limit ${limit}`.if(limit !== undefined)}${sql` offset ${offset}`.if(offset !== undefined)}`,
      selection
    }
  }
}

/**
 * Loose internal view of `DBQueryConfig`: the public API types constrain the
 * config; the compiler here only reads the fields that exist per mode.
 */
interface SpannerRelationalQueryParams {
  columns?: Record<string, boolean | undefined>
  where?: unknown
  extras?: unknown
  orderBy?: unknown
  limit?: number
  offset?: number
  with?: Record<string, unknown>
}

export type SpannerRelationalQueryConfigEntry =
  | SpannerRelationalQueryParams
  | true
  | undefined

export interface SpannerRelationalQueryInput {
  schema: AnyRelations
  table: SpannerTable
  tableConfig: TableRelationalConfig
  queryConfig: SpannerRelationalQueryConfigEntry
  relationWhere?: SQL
  mode: 'first' | 'many'
  errorPath?: string
  depth?: number
  throughJoin?: SQL
}

export type { Query }
