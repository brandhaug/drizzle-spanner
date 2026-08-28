import { type Column } from 'drizzle-orm/column'
import { type SQL } from 'drizzle-orm/sql'
import * as utils from 'drizzle-orm/utils'

/**
 * drizzle-orm exports these helpers at runtime but strips them from the
 * published .d.ts as @internal. Re-export them with the types the runtime
 * actually implements (verified in the dialect-internals research and spike).
 */

interface SelectedFieldsOrderedItem {
  path: Array<string>
  field: Column<any> | SQL | SQL.Aliased
}

export type SelectedFieldsOrdered = Array<SelectedFieldsOrderedItem>

type SelectedFields = Record<string, unknown>

interface InternalUtils {
  // Arrow-property signatures, not method signatures: these are plain
  // utility functions re-exported unbound (drizzle-orm's utils are
  // `this`-less), and the method syntax would trip unbound-method on the
  // re-export below.
  orderSelectedFields: (
    fields: SelectedFields,
    pathPrefix?: Array<string>
  ) => SelectedFieldsOrdered
  mapResultRow: <TResult>(
    columns: SelectedFieldsOrdered,
    row: Array<unknown>,
    joinsNotNullableMap: Record<string, boolean> | undefined
  ) => TResult
}

const internal = utils as unknown as InternalUtils

export const orderSelectedFields = internal.orderSelectedFields
export const mapResultRow = internal.mapResultRow
