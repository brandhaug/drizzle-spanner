import type { Casing } from 'drizzle-orm/utils';
import { CasingCache } from 'drizzle-orm/casing';
import { entityKind, is } from 'drizzle-orm/entity';
import type {
  DriverValueEncoder,
  Query,
  QueryTypingsValue,
  QueryWithTypings,
  SQLChunk,
} from 'drizzle-orm/sql';
import { Column } from 'drizzle-orm/column';
import { Param, SQL, sql } from 'drizzle-orm/sql';
import type { SelectedFieldsOrdered } from './internal.js';
import { orderSelectedFields } from './internal.js';
import { SpannerArray, SpannerColumn } from './columns/common.js';
import { SpannerBool } from './columns/bool.js';
import { SpannerBytes } from './columns/bytes.js';
import { SpannerDateDate, SpannerDateString } from './columns/date.js';
import { SpannerFloat32 } from './columns/float32.js';
import { SpannerFloat64 } from './columns/float64.js';
import { SpannerInt64BigInt, SpannerInt64Number } from './columns/int64.js';
import { SpannerJson } from './columns/json.js';
import { SpannerNumericNumber, SpannerNumericString } from './columns/numeric.js';
import { SpannerString } from './columns/string.js';
import { SpannerTimestamp } from './columns/timestamp.js';
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
 * Spanner type hint for a schema column, carried through drizzle's `typings`
 * channel. The upstream `QueryTypingsValue` union is closed at the type level
 * but unvalidated at runtime (spike finding); the session decodes these into
 * driver `types` entries. Arrays encode as `array:<element>`.
 */
function spannerTyping(column: SpannerColumn<any>): string {
  if (is(column, SpannerInt64Number) || is(column, SpannerInt64BigInt)) return 'int64';
  if (is(column, SpannerFloat64)) return 'float64';
  if (is(column, SpannerFloat32)) return 'float32';
  if (is(column, SpannerNumericString) || is(column, SpannerNumericNumber)) return 'numeric';
  if (is(column, SpannerString)) return 'string';
  if (is(column, SpannerBytes)) return 'bytes';
  if (is(column, SpannerBool)) return 'bool';
  if (is(column, SpannerDateString) || is(column, SpannerDateDate)) return 'date';
  if (is(column, SpannerTimestamp)) return 'timestamp';
  if (is(column, SpannerJson)) return 'json';
  if (is(column, SpannerArray)) return `array:${spannerTyping(column.baseColumn)}`;
  return 'none';
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

  prepareTyping = (encoder: DriverValueEncoder<unknown, unknown>): QueryTypingsValue => {
    if (is(encoder, SpannerColumn)) {
      return spannerTyping(encoder) as QueryTypingsValue;
    }
    return 'none';
  };

  sqlToQuery(sqlInput: SQL, invokeSource?: 'indexes' | undefined): QueryWithTypings {
    return sqlInput.toQuery({
      casing: this.casing,
      escapeName: this.escapeName,
      escapeParam: this.escapeParam,
      escapeString: this.escapeString,
      prepareTyping: this.prepareTyping,
      invokeSource,
    });
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
    const { table, values, returning } = config;
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

    const returningSql = returning
      ? sql` then return ${this.buildSelection(returning)}`
      : undefined;
    return sql`insert into ${table} ${insertOrder} values ${valuesSql}${returningSql}`;
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
    const returningSql = returning
      ? sql` then return ${this.buildSelection(returning)}`
      : undefined;
    // Spanner rejects UPDATE without WHERE; `where true` affects all rows.
    const whereSql = where ? sql` where ${where}` : sql` where true`;
    return sql`update ${table} set ${setSql}${whereSql}${returningSql}`;
  }

  buildDeleteQuery(config: SpannerDeleteConfig): SQL {
    const { table, where, returning } = config;
    const returningSql = returning
      ? sql` then return ${this.buildSelection(returning)}`
      : undefined;
    const whereSql = where ? sql` where ${where}` : sql` where true`;
    return sql`delete from ${table}${whereSql}${returningSql}`;
  }

  buildCountQuery(table: SpannerTable | SQL, where?: SQL): SQL {
    const whereSql = where ? sql` where ${where}` : undefined;
    return sql`select count(*) as ${sql.identifier('count')} from ${table}${whereSql}`;
  }
}

export type { Query };
