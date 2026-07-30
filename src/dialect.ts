import type { Casing } from 'drizzle-orm/utils';
import { aliasedTable } from 'drizzle-orm/alias';
import { CasingCache } from 'drizzle-orm/casing';
import { entityKind, is } from 'drizzle-orm/entity';
import { DrizzleError } from 'drizzle-orm/errors';
import type {
  AnyRelations,
  BuildRelationalQueryResult,
  TableRelationalConfig,
} from 'drizzle-orm/relations';
import {
  getTableAsAliasSQL,
  One,
  relationExtrasToSQL,
  relationsFilterToSQL,
  relationsOrderToSQL,
  relationToSQL,
} from 'drizzle-orm/relations';
import type {
  DriverValueEncoder,
  Query,
  QueryTypingsValue,
  QueryWithTypings,
  SQLChunk,
} from 'drizzle-orm/sql';
import { Column } from 'drizzle-orm/column';
import { and } from 'drizzle-orm/sql/expressions';
import { Param, SQL, sql } from 'drizzle-orm/sql';
import type { SelectedFieldsOrdered } from './orm-internal.js';
import { orderSelectedFields } from './orm-internal.js';
import { SpannerColumn } from './columns/common.js';
import type { SpannerTable } from './table.js';
import { TableColumns } from './symbols.js';

export interface SpannerDialectConfig {
  casing?: Casing;
}

export interface SpannerSelectConfig {
  table: SpannerTable | SQL;
  fields: Record<string, unknown>;
  fieldsFlat?: SelectedFieldsOrdered;
  where?: SQL;
  orderBy?: (SpannerColumn<any> | SQL)[];
  limit?: number | SQL;
  offset?: number | SQL;
}

export interface SpannerInsertConfig {
  table: SpannerTable;
  values: Record<string, Param | SQL>[];
  returning?: SelectedFieldsOrdered;
  /** `INSERT OR UPDATE` / `INSERT OR IGNORE` (ADR 0002) — Spanner's upsert forms. */
  conflictAction?: 'update' | 'ignore';
}

export interface SpannerUpdateConfig {
  table: SpannerTable;
  set: Record<string, Param | SQL>;
  where?: SQL;
  returning?: SelectedFieldsOrdered;
}

export interface SpannerDeleteConfig {
  table: SpannerTable;
  where?: SQL;
  returning?: SelectedFieldsOrdered;
}

/**
 * `QueryWithTypings` plus the column name behind each positional parameter,
 * so error hints can name the column a failing parameter binds.
 */
export interface SpannerQueryWithTypings extends QueryWithTypings {
  paramColumns?: (string | undefined)[];
}

export class SpannerDialect {
  static readonly [entityKind]: string = 'SpannerDialect';

  /** @internal */
  readonly casing: CasingCache;

  constructor(config?: SpannerDialectConfig) {
    this.casing = new CasingCache(config?.casing);
  }

  escapeName(name: string): string {
    return `\`${name}\``;
  }

  escapeParam(num: number): string {
    return `@p${num}`;
  }

  escapeString(str: string): string {
    return `'${str.replace(/'/g, "\\'")}'`;
  }

  /**
   * The type hint each column emits rides through drizzle's `typings` channel;
   * the upstream `QueryTypingsValue` union is closed at the type level but
   * unvalidated at runtime (spike finding). The session decodes the hints into
   * driver `types` entries.
   */
  prepareTyping = (encoder: DriverValueEncoder<unknown, unknown>): QueryTypingsValue => {
    if (is(encoder, SpannerColumn)) {
      return encoder.typeHint() as QueryTypingsValue;
    }
    return 'none';
  };

  sqlToQuery(sqlInput: SQL, invokeSource?: 'indexes' | undefined): SpannerQueryWithTypings {
    // prepareTyping fires once per parameter in order, so this doubles as the
    // param-index → column-name record used by error hints.
    const paramColumns: (string | undefined)[] = [];
    const query = sqlInput.toQuery({
      casing: this.casing,
      escapeName: this.escapeName,
      escapeParam: this.escapeParam,
      escapeString: this.escapeString,
      prepareTyping: (encoder) => {
        paramColumns.push(is(encoder, SpannerColumn) ? encoder.name : undefined);
        return this.prepareTyping(encoder);
      },
      invokeSource,
    });
    return { ...query, paramColumns };
  }

  private buildSelection(fields: SelectedFieldsOrdered): SQL {
    const columnsLen = fields.length;
    const chunks = fields.flatMap(({ field }, i) => {
      const chunk: SQLChunk[] = [];
      if (is(field, SQL.Aliased)) {
        chunk.push(field.sql, sql` as ${sql.identifier(field.fieldAlias)}`);
      } else if (is(field, SQL) || is(field, Column)) {
        chunk.push(field);
      }
      if (i < columnsLen - 1) chunk.push(sql`, `);
      return chunk;
    });
    return sql.join(chunks);
  }

  private buildReturning(returning: SelectedFieldsOrdered | undefined): SQL | undefined {
    return returning ? sql` then return ${this.buildSelection(returning)}` : undefined;
  }

  /** Spanner rejects UPDATE/DELETE without WHERE; `where true` affects all rows (ADR 0001). */
  private buildWhereOrTrue(where: SQL | undefined): SQL {
    return where ? sql` where ${where}` : sql` where true`;
  }

  buildSelectQuery(config: SpannerSelectConfig): SQL {
    const { fields, fieldsFlat, where, table, orderBy, limit, offset } = config;
    const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
    const selection = this.buildSelection(fieldsList);
    const whereSql = where ? sql` where ${where}` : undefined;
    const orderBySql =
      orderBy && orderBy.length > 0 ? sql` order by ${sql.join(orderBy, sql`, `)}` : undefined;
    const limitSql =
      typeof limit === 'number' || is(limit, SQL) ? sql` limit ${limit}` : undefined;
    const offsetSql =
      typeof offset === 'number' || is(offset, SQL) ? sql` offset ${offset}` : undefined;
    return sql`select ${selection} from ${table}${whereSql}${orderBySql}${limitSql}${offsetSql}`;
  }

  buildInsertQuery(config: SpannerInsertConfig): SQL {
    const { table, values, returning, conflictAction } = config;
    const columns = table[TableColumns];
    const colEntries = Object.entries(columns);
    const insertOrder = colEntries.map(([, column]) =>
      sql.identifier(this.casing.getColumnCasing(column)),
    );

    const valuesSqlList: (SQLChunk[] | SQL)[] = [];
    for (const [valueIndex, value] of values.entries()) {
      const valueList: SQLChunk[] = [];
      for (const [fieldName] of colEntries) {
        const colValue = value[fieldName];
        if (colValue === undefined || (is(colValue, Param) && colValue.value === undefined)) {
          valueList.push(sql`default`);
        } else {
          valueList.push(colValue);
        }
      }
      valuesSqlList.push(valueList);
      if (valueIndex < values.length - 1) valuesSqlList.push(sql`, `);
    }
    const valuesSql = sql.join(valuesSqlList);

    const returningSql = this.buildReturning(returning);
    const insertKeyword =
      conflictAction === undefined ? sql`insert` : sql.raw(`insert or ${conflictAction}`);
    return sql`${insertKeyword} into ${table} ${insertOrder} values ${valuesSql}${returningSql}`;
  }

  buildUpdateSet(table: SpannerTable, set: Record<string, Param | SQL>): SQL {
    const tableColumns = table[TableColumns];
    const columnNames = Object.keys(tableColumns).filter(
      (columnName) => set[columnName] !== undefined,
    );
    const setLength = columnNames.length;
    return sql.join(
      columnNames.flatMap((columnName, i) => {
        const column = tableColumns[columnName]!;
        const value = set[columnName]!;
        const assignment = sql`${sql.identifier(this.casing.getColumnCasing(column))} = ${value}`;
        return i < setLength - 1 ? [assignment, sql.raw(', ')] : [assignment];
      }),
    );
  }

  buildUpdateQuery(config: SpannerUpdateConfig): SQL {
    const { table, set, where, returning } = config;
    const setSql = this.buildUpdateSet(table, set);
    return sql`update ${table} set ${setSql}${this.buildWhereOrTrue(where)}${this.buildReturning(returning)}`;
  }

  buildDeleteQuery(config: SpannerDeleteConfig): SQL {
    const { table, where, returning } = config;
    return sql`delete from ${table}${this.buildWhereOrTrue(where)}${this.buildReturning(returning)}`;
  }

  buildCountQuery(table: SpannerTable | SQL, where?: SQL): SQL {
    const whereSql = where ? sql` where ${where}` : undefined;
    return sql`select count(*) as ${sql.identifier('count')} from ${table}${whereSql}`;
  }

  private buildRqbColumn(table: SpannerTable, column: unknown, key: string): SQL {
    if (is(column, Column)) {
      return sql`${table}.${sql.identifier(this.casing.getColumnCasing(column))} as ${sql.identifier(key)}`;
    }
    throw new DrizzleError({
      message: `Field "${key}" is not a column; the relational query builder selects table columns (use extras for SQL expressions)`,
    });
  }

  /** Column list of one RQB level, honoring the `columns` include/exclude config. */
  private buildRqbColumns(
    table: SpannerTable,
    selection: BuildRelationalQueryResult['selection'],
    config?: SpannerRelationalQueryConfigEntry,
  ): SQL | undefined {
    const columnContainer = table[TableColumns];
    const columnsConfig = config === true || config === undefined ? undefined : config.columns;
    const columnIdentifiers: SQL[] = [];
    const pushColumn = (key: string, column: SpannerColumn<any>): void => {
      columnIdentifiers.push(this.buildRqbColumn(table, column, key));
      selection.push({ key, field: column as never });
    };
    if (columnsConfig) {
      const entries = Object.entries(columnsConfig).filter(([, value]) => value !== undefined);
      const included = entries.filter(([, value]) => value);
      if (included.length > 0) {
        for (const [key] of included) pushColumn(key, columnContainer[key]!);
      } else {
        // Exclusion mode: everything except the false keys.
        for (const [key, column] of Object.entries(columnContainer)) {
          if (columnsConfig[key] === false) continue;
          pushColumn(key, column);
        }
      }
      return columnIdentifiers.length > 0 ? sql.join(columnIdentifiers, sql`, `) : undefined;
    }
    for (const [key, column] of Object.entries(columnContainer)) pushColumn(key, column);
    return sql.join(columnIdentifiers, sql`, `);
  }

  /**
   * Relational query compiler (spec: relational queries). Nested collections
   * become correlated `ARRAY(SELECT AS STRUCT ...)` subqueries and to-one
   * relations a scalar `(SELECT AS STRUCT ... LIMIT 1)` — one round trip,
   * decoded with full type fidelity through the driver's STRUCT values.
   */
  buildRelationalQuery(config: SpannerRelationalQueryInput): BuildRelationalQueryResult {
    const { schema, tableConfig, queryConfig, relationWhere, mode, throughJoin } = config;
    const selection: BuildRelationalQueryResult['selection'] = [];
    const isSingle = mode === 'first';
    const params = queryConfig === true ? undefined : queryConfig;
    const currentPath = config.errorPath ?? '';
    const currentDepth = config.depth ?? 0;
    const table = currentDepth
      ? (config.table as SpannerTable)
      : (aliasedTable(config.table as never, `d${currentDepth}`) as unknown as SpannerTable);

    const limit = isSingle ? 1 : params?.limit;
    const offset = params?.offset;
    const filter = params?.where
      ? relationsFilterToSQL(
          table as never,
          params.where as never,
          tableConfig.relations,
          schema,
          this.casing,
        )
      : undefined;
    const where = filter && relationWhere ? and(filter, relationWhere) : (filter ?? relationWhere);
    const order = params?.orderBy
      ? relationsOrderToSQL(table as never, params.orderBy as never)
      : undefined;

    const columns = this.buildRqbColumns(table, selection, queryConfig);
    const extras = params?.extras
      ? relationExtrasToSQL(table as never, params.extras as never)
      : undefined;
    if (extras) selection.push(...extras.selection);

    const selectionArr: SQL[] = columns ? [columns] : [];
    const withEntries = params?.with
      ? Object.entries(params.with as Record<string, unknown>).filter(([, value]) => value)
      : [];
    for (const [key, join] of withEntries) {
      const relation = tableConfig.relations[key]!;
      const isSingleRelation = is(relation, One);
      const targetTable = aliasedTable(
        relation.targetTable as never,
        `d${currentDepth + 1}`,
      ) as unknown as SpannerTable;
      const throughTable = relation.throughTable
        ? (aliasedTable(relation.throughTable as never, `tr${currentDepth}`) as unknown as SpannerTable)
        : undefined;
      const built = relationToSQL(
        this.casing,
        relation,
        table as never,
        targetTable as never,
        throughTable as never,
      );
      const innerThroughJoin = throughTable
        ? sql` inner join ${getTableAsAliasSQL(throughTable as never)} on ${built.joinCondition}`
        : undefined;
      const innerQuery = this.buildRelationalQuery({
        schema,
        table: targetTable,
        tableConfig: schema[relation.targetTableName]!,
        queryConfig: join as SpannerRelationalQueryConfigEntry,
        relationWhere: built.filter,
        mode: isSingleRelation ? 'first' : 'many',
        errorPath: `${currentPath.length > 0 ? `${currentPath}.` : ''}${key}`,
        depth: currentDepth + 1,
        throughJoin: innerThroughJoin,
      });
      selection.push({
        field: targetTable as never,
        key,
        selection: innerQuery.selection,
        isArray: !isSingleRelation,
        isOptional:
          ((relation as { optional?: boolean }).optional ?? false) ||
          (join !== true && !!(join as { where?: unknown }).where),
      });
      // Spanner cannot return a bare STRUCT as a column value, so to-one
      // relations also compile to ARRAY(...) (with LIMIT 1 from mode
      // 'first'); the decoder unwraps the single element.
      selectionArr.push(sql`array(${innerQuery.sql}) as ${sql.identifier(key)}`);
    }
    if (extras?.sql) selectionArr.push(extras.sql);
    if (selectionArr.length === 0) {
      throw new DrizzleError({
        message: `No fields selected for table "${tableConfig.name}"${currentPath ? ` ("${currentPath}")` : ''}`,
      });
    }

    const selectKeyword = currentDepth ? sql`select as struct ` : sql`select `;
    return {
      sql: sql`${selectKeyword}${sql.join(selectionArr, sql`, `)} from ${getTableAsAliasSQL(table as never)}${throughJoin}${sql` where ${where}`.if(where)}${sql` order by ${order}`.if(order)}${sql` limit ${limit}`.if(limit !== undefined)}${sql` offset ${offset}`.if(offset !== undefined)}`,
      selection,
    };
  }
}

/**
 * Loose internal view of `DBQueryConfig`: the public API types constrain the
 * config; the compiler here only reads the fields that exist per mode.
 */
interface SpannerRelationalQueryParams {
  columns?: Record<string, boolean | undefined>;
  where?: unknown;
  extras?: unknown;
  orderBy?: unknown;
  limit?: number;
  offset?: number;
  with?: Record<string, unknown>;
}

type SpannerRelationalQueryConfigEntry = SpannerRelationalQueryParams | true | undefined;

export interface SpannerRelationalQueryInput {
  schema: AnyRelations;
  table: SpannerTable;
  tableConfig: TableRelationalConfig;
  queryConfig: SpannerRelationalQueryConfigEntry;
  relationWhere?: SQL;
  mode: 'first' | 'many';
  errorPath?: string;
  depth?: number;
  throughJoin?: SQL;
}

export type { Query };
