// Spike: SpannerSession + SpannerPreparedQuery over @google-cloud/spanner.
// Reads run through database.run(); DML runs through database.runTransactionAsync().
// Inside db.transaction() everything runs on the one Spanner Transaction object.
import { entityKind } from 'drizzle-orm/entity';
import { mapResultRow } from 'drizzle-orm/utils';
import { fillPlaceholders } from 'drizzle-orm/sql';
import { NoopLogger } from 'drizzle-orm/logger';

function toNamedParams(params, typings) {
	const named = {};
	const types = {};
	for (const [i, value] of params.entries()) {
		named[`p${i}`] = value;
		const typing = typings?.[i];
		if (typing && typing !== 'none') {
			types[`p${i}`] = typing;
		}
	}
	return { named, types };
}

export class SpannerPreparedQuery {
	static [entityKind] = 'SpannerPreparedQuery';

	constructor(runner, query, logger, fields, customResultMapper, queryMetadata) {
		this.runner = runner; // { run(request), isDml-aware }
		this.query = query; // { sql, params, typings }
		this.logger = logger;
		this.fields = fields;
		this.customResultMapper = customResultMapper;
		this.queryMetadata = queryMetadata;
	}

	getQuery() {
		return this.query;
	}

	mapResult(response) {
		return response;
	}

	async execute(placeholderValues = {}) {
		const params = fillPlaceholders(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		const { named, types } = toNamedParams(params, this.query.typings);
		const request = {
			sql: this.query.sql,
			params: named,
			types,
		};
		const isDml = this.queryMetadata
			? this.queryMetadata.type !== 'select'
			: /^\s*(insert|update|delete)/i.test(this.query.sql);
		const rawRows = await this.runner.run(request, isDml);
		if (!this.fields && !this.customResultMapper) {
			return rawRows.map((row) => row.toJSON());
		}
		// Array row mode: Spanner rows are arrays of { name, value } in select order.
		const rows = rawRows.map((row) => row.map((cell) => cell.value));
		if (this.customResultMapper) return this.customResultMapper(rows);
		return rows.map((row) => mapResultRow(this.fields, row, undefined));
	}

	async all(placeholderValues = {}) {
		return this.execute(placeholderValues);
	}
}

// Runner over a Database: reads via database.run, DML via runTransactionAsync.
class DatabaseRunner {
	constructor(database) {
		this.database = database;
	}
	async run(request, isDml) {
		if (!isDml) {
			const [rows] = await this.database.run(request);
			return rows;
		}
		return this.database.runTransactionAsync(async (txn) => {
			const [rows] = await txn.run(request);
			await txn.commit();
			return rows;
		});
	}
}

// Runner over an open read-write Transaction.
class TransactionRunner {
	constructor(txn) {
		this.txn = txn;
	}
	async run(request) {
		const [rows] = await this.txn.run(request);
		return rows;
	}
}

export class SpannerSession {
	static [entityKind] = 'SpannerSession';

	constructor(runner, dialect, options = {}) {
		this.runner = runner;
		this.dialect = dialect;
		this.options = options;
		this.logger = options.logger ?? new NoopLogger();
	}

	prepareQuery(query, fields, name, isResponseInArrayMode, customResultMapper, queryMetadata) {
		return new SpannerPreparedQuery(this.runner, query, this.logger, fields, customResultMapper, queryMetadata);
	}

	execute(query) {
		return this.prepareQuery(this.dialect.sqlToQuery(query)).execute();
	}
}

export function createDatabaseSession(database, dialect, options) {
	return new SpannerSession(new DatabaseRunner(database), dialect, options);
}

export function createTransactionSession(txn, dialect, options) {
	return new SpannerSession(new TransactionRunner(txn), dialect, options);
}
