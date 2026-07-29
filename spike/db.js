// Spike: SpannerDatabase + minimal select/insert/update/delete builders.
// Same shape as gel-core query builders, trimmed to the spike's needs.
import { entityKind, is } from 'drizzle-orm/entity';
import { Table } from 'drizzle-orm/table';
import { Param, SQL } from 'drizzle-orm/sql';
import { QueryPromise } from 'drizzle-orm/query-promise';
import { orderSelectedFields } from 'drizzle-orm/utils';
import { createTransactionSession } from './session.js';

class SpannerSelectBase extends QueryPromise {
	static [entityKind] = 'SpannerSelect';

	constructor(table, fields, session, dialect) {
		super();
		this.session = session;
		this.dialect = dialect;
		this.config = { table, fields, setOperators: [] };
	}

	where(where) {
		this.config.where = where;
		return this;
	}

	orderBy(...orderBy) {
		this.config.orderBy = orderBy;
		return this;
	}

	limit(limit) {
		this.config.limit = limit;
		return this;
	}

	getSQL() {
		return this.dialect.buildSelectQuery(this.config);
	}

	toSQL() {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	_prepare() {
		const fieldsList = orderSelectedFields(this.config.fields);
		return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), fieldsList, undefined, true, undefined, {
			type: 'select',
			tables: [],
		});
	}

	execute = (placeholderValues) => this._prepare().execute(placeholderValues);
}

class SpannerSelectBuilder {
	static [entityKind] = 'SpannerSelectBuilder';
	constructor(fields, session, dialect) {
		this.fields = fields;
		this.session = session;
		this.dialect = dialect;
	}
	from(table) {
		const fields = this.fields ?? table[Table.Symbol.Columns];
		return new SpannerSelectBase(table, fields, this.session, this.dialect);
	}
}

class SpannerInsertBuilder {
	static [entityKind] = 'SpannerInsertBuilder';
	constructor(table, session, dialect) {
		this.table = table;
		this.session = session;
		this.dialect = dialect;
	}
	values(values) {
		values = Array.isArray(values) ? values : [values];
		if (values.length === 0) throw new Error('values() must be called with at least one value');
		const mappedValues = values.map((entry) => {
			const result = {};
			const cols = this.table[Table.Symbol.Columns];
			for (const colKey of Object.keys(entry)) {
				const colValue = entry[colKey];
				result[colKey] = is(colValue, SQL) ? colValue : new Param(colValue, cols[colKey]);
			}
			return result;
		});
		return new SpannerInsertBase(this.table, mappedValues, this.session, this.dialect);
	}
}

class SpannerInsertBase extends QueryPromise {
	static [entityKind] = 'SpannerInsert';
	constructor(table, values, session, dialect) {
		super();
		this.session = session;
		this.dialect = dialect;
		this.config = { table, values };
	}
	returning(fields = this.config.table[Table.Symbol.Columns]) {
		this.config.returning = orderSelectedFields(fields);
		return this;
	}
	getSQL() {
		return this.dialect.buildInsertQuery(this.config);
	}
	toSQL() {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}
	_prepare() {
		return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, undefined, true, undefined, {
			type: 'insert',
			tables: [],
		});
	}
	execute = (placeholderValues) => this._prepare().execute(placeholderValues);
}

class SpannerUpdateBuilder {
	static [entityKind] = 'SpannerUpdateBuilder';
	constructor(table, session, dialect) {
		this.table = table;
		this.session = session;
		this.dialect = dialect;
	}
	set(values) {
		const cols = this.table[Table.Symbol.Columns];
		const mapped = {};
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) continue;
			mapped[key] = is(value, SQL) ? value : new Param(value, cols[key]);
		}
		return new SpannerUpdateBase(this.table, mapped, this.session, this.dialect);
	}
}

class SpannerUpdateBase extends QueryPromise {
	static [entityKind] = 'SpannerUpdate';
	constructor(table, set, session, dialect) {
		super();
		this.session = session;
		this.dialect = dialect;
		this.config = { table, set };
	}
	where(where) {
		this.config.where = where;
		return this;
	}
	returning(fields = this.config.table[Table.Symbol.Columns]) {
		this.config.returning = orderSelectedFields(fields);
		return this;
	}
	getSQL() {
		return this.dialect.buildUpdateQuery(this.config);
	}
	toSQL() {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}
	_prepare() {
		return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, undefined, true, undefined, {
			type: 'update',
			tables: [],
		});
	}
	execute = (placeholderValues) => this._prepare().execute(placeholderValues);
}

class SpannerDeleteBase extends QueryPromise {
	static [entityKind] = 'SpannerDelete';
	constructor(table, session, dialect) {
		super();
		this.session = session;
		this.dialect = dialect;
		this.config = { table };
	}
	where(where) {
		this.config.where = where;
		return this;
	}
	returning(fields = this.config.table[Table.Symbol.Columns]) {
		this.config.returning = orderSelectedFields(fields);
		return this;
	}
	getSQL() {
		return this.dialect.buildDeleteQuery(this.config);
	}
	toSQL() {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}
	_prepare() {
		return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, undefined, true, undefined, {
			type: 'delete',
			tables: [],
		});
	}
	execute = (placeholderValues) => this._prepare().execute(placeholderValues);
}

export class SpannerDatabase {
	static [entityKind] = 'SpannerDatabase';

	constructor(dialect, session, spannerDatabase) {
		this.dialect = dialect;
		this.session = session;
		this.$client = spannerDatabase;
	}

	select(fields) {
		return new SpannerSelectBuilder(fields, this.session, this.dialect);
	}

	insert(table) {
		return new SpannerInsertBuilder(table, this.session, this.dialect);
	}

	update(table) {
		return new SpannerUpdateBuilder(table, this.session, this.dialect);
	}

	delete(table) {
		return new SpannerDeleteBase(table, this.session, this.dialect);
	}

	execute(query) {
		return this.session.execute(query);
	}

	// One read-write transaction over database.runTransactionAsync.
	async transaction(callback) {
		return this.$client.runTransactionAsync(async (txn) => {
			const txSession = createTransactionSession(txn, this.dialect, this.session.options);
			const tx = new SpannerTransaction(this.dialect, txSession, this.$client);
			const result = await callback(tx);
			await txn.commit();
			return result;
		});
	}
}

export class SpannerTransaction extends SpannerDatabase {
	static [entityKind] = 'SpannerTransaction';
	transaction() {
		throw new Error('Nested transactions are not supported in the spike');
	}
	rollback() {
		throw new Error('Rollback requested');
	}
}
