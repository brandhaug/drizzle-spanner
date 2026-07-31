/**
 * drizzle-orm keys table internals with globally registered symbols
 * (`Symbol.for('drizzle:...')`). The `Table.Symbol` static that exposes them
 * is stripped from the published .d.ts as @internal, so re-derive the same
 * symbols here with types.
 */
export const TableName: unique symbol = Symbol.for('drizzle:Name')
export const TableColumns: unique symbol = Symbol.for('drizzle:Columns')
export const ExtraConfigColumns: unique symbol = Symbol.for(
  'drizzle:ExtraConfigColumns'
)
export const ExtraConfigBuilder: unique symbol = Symbol.for(
  'drizzle:ExtraConfigBuilder'
)
