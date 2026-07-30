/**
 * Internal wiring surface, exported as `drizzle-spanner/internal`.
 *
 * These helpers exist so drizzle-spanner-kit (and tests) can reuse the
 * adapter's conversion and introspection machinery. They are NOT public
 * API: no semver stability is promised, and application code should not
 * import from this subpath.
 */
export { unwrapDriverWrapper, unwrapFloat } from './columns/common.js';
export { createDatabaseSession, createMockSession } from './db.js';
export { wrapSpannerError } from './errors.js';
export {
  MUTATION_MODE_READ_MESSAGE,
  MUTATION_MODE_RETURNING_MESSAGE,
  toMutationRow,
  whereToPrimaryKey,
} from './mutations.js';
export { mapRowToParams } from './query-builders/query-base.js';
export { NO_CLIENT_MESSAGE, driverRowToObject, toNamedParams } from './session.js';
export { toTimestampBounds } from './staleness.js';
export { getPrimaryKeyColumns, getTableExtraConfig } from './table.js';
export { arrayTypeHint, toDriverParamType } from './type-hints.js';
