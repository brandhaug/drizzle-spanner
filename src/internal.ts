import type { Column } from 'drizzle-orm/column';
import type { SQL } from 'drizzle-orm/sql';
import type { Table } from 'drizzle-orm/table';
import * as utils from 'drizzle-orm/utils';

/**
 * drizzle-orm exports these helpers at runtime but strips them from the
 * published .d.ts as @internal. Re-export them with the types the runtime
 * actually implements (verified in the dialect-internals research and spike).
 */

export interface SelectedFieldsOrderedItem {
  path: string[];
  field: Column<any> | SQL | SQL.Aliased;
}

export type SelectedFieldsOrdered = SelectedFieldsOrderedItem[];

export type SelectedFields = Record<string, unknown>;

interface InternalUtils {
  orderSelectedFields(fields: SelectedFields, pathPrefix?: string[]): SelectedFieldsOrdered;
  mapResultRow<TResult>(
    columns: SelectedFieldsOrdered,
    row: unknown[],
    joinsNotNullableMap: Record<string, boolean> | undefined,
  ): TResult;
  mapUpdateSet(table: Table, values: Record<string, unknown>): Record<string, unknown>;
}

const internal = utils as unknown as InternalUtils;

export const orderSelectedFields = internal.orderSelectedFields;
export const mapResultRow = internal.mapResultRow;
export const mapUpdateSet = internal.mapUpdateSet;
