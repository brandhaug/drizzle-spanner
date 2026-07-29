// Spike: minimal Spanner column builders. Throwaway code.
import { entityKind } from 'drizzle-orm/entity';
import { Column } from 'drizzle-orm/column';
import { ColumnBuilder } from 'drizzle-orm/column-builder';

export class SpannerColumnBuilder extends ColumnBuilder {
	static [entityKind] = 'SpannerColumnBuilder';
	/** @internal */
	buildExtraConfigColumn(table) {
		return this.build(table);
	}
	/** @internal */
	buildForeignKeys() {
		return [];
	}
}

export class SpannerColumn extends Column {
	static [entityKind] = 'SpannerColumn';
	constructor(table, config) {
		super(table, config);
		this.table = table;
	}
}

// STRING(n | MAX)
export class SpannerStringBuilder extends SpannerColumnBuilder {
	static [entityKind] = 'SpannerStringBuilder';
	constructor(name, options = {}) {
		super(name, 'string', 'SpannerString');
		this.config.length = options.length ?? 'max';
	}
	defaultGenerateUuid() {
		this.config.hasDefault = true;
		this.config.defaultGenerateUuid = true;
		return this;
	}
	build(table) {
		return new SpannerString(table, this.config);
	}
}
export class SpannerString extends SpannerColumn {
	static [entityKind] = 'SpannerString';
	getSQLType() {
		return `STRING(${String(this.config.length).toUpperCase()})`;
	}
}
export function string(name, options) {
	return new SpannerStringBuilder(name, options);
}

// INT64 (number mode)
export class SpannerInt64Builder extends SpannerColumnBuilder {
	static [entityKind] = 'SpannerInt64Builder';
	constructor(name) {
		super(name, 'number', 'SpannerInt64');
	}
	build(table) {
		return new SpannerInt64(table, this.config);
	}
}
export class SpannerInt64 extends SpannerColumn {
	static [entityKind] = 'SpannerInt64';
	getSQLType() {
		return 'INT64';
	}
	mapFromDriverValue(value) {
		// @google-cloud/spanner returns Int wrappers ({ value: '42' }) in array row mode.
		if (value === null) return null;
		if (typeof value === 'object' && value !== null && 'value' in value) {
			return Number(value.value);
		}
		return Number(value);
	}
}
export function int64(name) {
	return new SpannerInt64Builder(name);
}

// TIMESTAMP
export class SpannerTimestampBuilder extends SpannerColumnBuilder {
	static [entityKind] = 'SpannerTimestampBuilder';
	constructor(name) {
		super(name, 'date', 'SpannerTimestamp');
	}
	build(table) {
		return new SpannerTimestamp(table, this.config);
	}
}
export class SpannerTimestamp extends SpannerColumn {
	static [entityKind] = 'SpannerTimestamp';
	getSQLType() {
		return 'TIMESTAMP';
	}
	mapFromDriverValue(value) {
		if (value === null) return null;
		return value instanceof Date ? value : new Date(value);
	}
	mapToDriverValue(value) {
		return value;
	}
}
export function timestamp(name) {
	return new SpannerTimestampBuilder(name);
}
