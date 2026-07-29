// Spike: minimal SpannerDialect. Trimmed from gel-core/dialect.ts (reference reading).
// GoogleSQL differences vs gel/pg:
//   - identifiers escaped with backticks
//   - named params: @p0, @p1, ...
//   - RETURNING is spelled `THEN RETURN`
import { entityKind, is } from 'drizzle-orm/entity';
import { Table } from 'drizzle-orm/table';
import { Column } from 'drizzle-orm/column';
import { orderSelectedFields } from 'drizzle-orm/utils';
import { Param, SQL, sql } from 'drizzle-orm/sql';
import { CasingCache } from 'drizzle-orm/casing';
import { SpannerInt64, SpannerString, SpannerTimestamp } from './columns.js';

export class SpannerDialect {
	static [entityKind] = 'SpannerDialect';

	constructor(config) {
		this.casing = new CasingCache(config?.casing);
	}

	escapeName(name) {
		return `\`${name}\``;
	}

	escapeParam(num) {
		return `@p${num}`;
	}

	escapeString(str) {
		return `'${str.replace(/'/g, "\\'")}'`;
	}

	buildSelection(fields) {
		const columnsLen = fields.length;
		const chunks = fields.flatMap(({ field }, i) => {
			const chunk = [];
			if (is(field, SQL.Aliased)) {
				chunk.push(field.sql, sql` as ${sql.identifier(field.fieldAlias)}`);
			} else if (is(field, SQL)) {
				chunk.push(field);
			} else if (is(field, Column)) {
				chunk.push(field);
			}
			if (i < columnsLen - 1) chunk.push(sql`, `);
			return chunk;
		});
		return sql.join(chunks);
	}

	buildSelectQuery({ fields, fieldsFlat, where, table, orderBy, limit, offset }) {
		const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
		const selection = this.buildSelection(fieldsList);
		const whereSql = where ? sql` where ${where}` : undefined;
		const orderBySql = orderBy && orderBy.length > 0 ? sql` order by ${sql.join(orderBy, sql`, `)}` : undefined;
		const limitSql = typeof limit === 'number' && limit >= 0 ? sql` limit ${limit}` : undefined;
		const offsetSql = offset ? sql` offset ${offset}` : undefined;
		return sql`select ${selection} from ${table}${whereSql}${orderBySql}${limitSql}${offsetSql}`;
	}

	buildInsertQuery({ table, values, returning }) {
		const valuesSqlList = [];
		const columns = table[Table.Symbol.Columns];
		const colEntries = Object.entries(columns);
		const insertOrder = colEntries.map(([, column]) => sql.identifier(this.casing.getColumnCasing(column)));
		valuesSqlList.push(sql.raw('values '));
		for (const [valueIndex, value] of values.entries()) {
			const valueList = [];
			for (const [fieldName, col] of colEntries) {
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
		const returningSql = returning ? sql` then return ${this.buildSelection(returning)}` : undefined;
		return sql`insert into ${table} ${insertOrder} ${valuesSql}${returningSql}`;
	}

	buildUpdateSet(table, set) {
		const tableColumns = table[Table.Symbol.Columns];
		const columnNames = Object.keys(tableColumns).filter((colName) => set[colName] !== undefined);
		const setLength = columnNames.length;
		return sql.join(
			columnNames.flatMap((colName, i) => {
				const col = tableColumns[colName];
				const value = set[colName];
				const res = sql`${sql.identifier(this.casing.getColumnCasing(col))} = ${value}`;
				if (i < setLength - 1) return [res, sql.raw(', ')];
				return [res];
			}),
		);
	}

	buildUpdateQuery({ table, set, where, returning }) {
		const setSql = this.buildUpdateSet(table, set);
		const returningSql = returning ? sql` then return ${this.buildSelection(returning)}` : undefined;
		// Spanner requires a WHERE clause on UPDATE/DELETE.
		return sql`update ${table} set ${setSql}${where ? sql` where ${where}` : sql` where true`}${returningSql}`;
	}

	buildDeleteQuery({ table, where, returning }) {
		const returningSql = returning ? sql` then return ${this.buildSelection(returning)}` : undefined;
		return sql`delete from ${table}${where ? sql` where ${where}` : sql` where true`}${returningSql}`;
	}

	// Spanner param type hints. The drizzle QueryTypingsValue union is closed at the
	// type level, but at runtime any string passes through — the spike exploits that.
	prepareTyping(encoder) {
		if (is(encoder, SpannerInt64)) return 'int64';
		if (is(encoder, SpannerTimestamp)) return 'timestamp';
		if (is(encoder, SpannerString)) return 'string';
		return 'none';
	}

	sqlToQuery(sqlInput, invokeSource) {
		return sqlInput.toQuery({
			casing: this.casing,
			escapeName: this.escapeName,
			escapeParam: this.escapeParam,
			escapeString: this.escapeString,
			prepareTyping: this.prepareTyping,
			invokeSource,
		});
	}
}
