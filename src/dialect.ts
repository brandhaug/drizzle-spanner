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

    const returningSql = this.buildReturning(returning);
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
}

export type { Query };
