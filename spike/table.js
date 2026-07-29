// Spike: minimal SpannerTable factory. Throwaway code.
import { entityKind } from 'drizzle-orm/entity';
import { Table } from 'drizzle-orm/table';

export class SpannerTable extends Table {
	static [entityKind] = 'SpannerTable';
	static Symbol = Object.assign({}, Table.Symbol);
	[Table.Symbol.ExtraConfigBuilder] = undefined;
	[Table.Symbol.ExtraConfigColumns] = {};
}

export function spannerTable(name, columns, extraConfig) {
	const rawTable = new SpannerTable(name, undefined, name);
	const builtColumns = Object.fromEntries(
		Object.entries(columns).map(([columnName, colBuilder]) => {
			colBuilder.setName(columnName);
			const column = colBuilder.build(rawTable);
			return [columnName, column];
		}),
	);
	const table = Object.assign(rawTable, builtColumns);
	table[Table.Symbol.Columns] = builtColumns;
	table[Table.Symbol.ExtraConfigColumns] = builtColumns;
	if (extraConfig) table[Table.Symbol.ExtraConfigBuilder] = extraConfig;
	return table;
}
