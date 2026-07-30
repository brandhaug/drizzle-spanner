// The package root is audited public API (see tests/unit/api-surface.test.ts).
// Modules that also define internal wiring helpers are re-exported by name;
// the helpers live under drizzle-spanner/internal instead.
export * from './columns/bool.js';
export * from './columns/bytes.js';
export {
  SpannerArray,
  SpannerArrayBuilder,
  SpannerColumn,
  SpannerColumnBuilder,
  SpannerExtraConfigColumn,
  SpannerFloatColumn,
} from './columns/common.js';
export type {
  BuildSpannerColumn,
  BuildSpannerColumns,
  BuildSpannerExtraConfigColumns,
  SpannerArrayBuilderConfig,
} from './columns/common.js';
export * from './columns/date.js';
export * from './columns/float32.js';
export * from './columns/float64.js';
export * from './columns/int64.js';
export * from './columns/json.js';
export * from './columns/numeric.js';
export * from './columns/string.js';
export * from './columns/timestamp.js';
export * from './columns/tokenlist.js';
export * from './checks.js';
export * from './commit-timestamp.js';
export * from './foreign-keys.js';
export { SpannerDatabase, SpannerDatabaseCore, SpannerTransaction } from './db.js';
export type {
  SpannerDatabaseOptions,
  SpannerDriverDatabase,
  SpannerDriverRunTransactionOptions,
  SpannerDriverSnapshot,
  SpannerDriverTransaction,
  SpannerMutationTransaction,
  SpannerMutationTransactionOptions,
  SpannerReadOnlyTransaction,
  SpannerReadOnlyTransactionOptions,
  SpannerReadWriteTransaction,
  SpannerRelationalQueries,
  SpannerTransactionOptions,
} from './db.js';
export * from './dialect.js';
export * from './driver.js';
export {
  GrpcStatus,
  SpannerAbortedError,
  SpannerConstraintError,
  SpannerDdlError,
  SpannerError,
  SpannerInvalidArgumentError,
  SpannerPrecisionError,
  SpannerUnavailableError,
} from './errors.js';
export type { SpannerErrorOptions, SpannerErrorQueryContext } from './errors.js';
export * from './indexes.js';
export * from './interleave.js';
export type { SpannerMutationSink } from './mutations.js';
export * from './primary-keys.js';
export * from './query-builders/delete.js';
export * from './query-builders/insert.js';
export {
  SpannerDmlBase,
  SpannerFilteredDmlBase,
  SpannerQueryBase,
} from './query-builders/query-base.js';
export type { SpannerDmlConfig } from './query-builders/query-base.js';
export * from './query-builders/query.js';
export * from './query-builders/select.js';
export * from './query-builders/update.js';
export * from './sequence.js';
export { SpannerPreparedQuery, SpannerSession } from './session.js';
export type {
  SpannerDriverRow,
  SpannerQueryMetadata,
  SpannerQueryRunner,
  SpannerSessionOptions,
  SpannerSqlRequest,
} from './session.js';
export type {
  SpannerMultiUseStaleness,
  SpannerProtoTimestamp,
  SpannerStaleness,
  SpannerTimestampBounds,
} from './staleness.js';
export { SpannerTable, spannerTable } from './table.js';
export type {
  AnySpannerTable,
  SpannerColumns,
  SpannerTableExtraConfigValue,
  SpannerTableExtraConfigValueFor,
  SpannerTableWithColumns,
  TableConfig,
} from './table.js';
export type {
  SpannerDriverParamType,
  SpannerScalarTypeHint,
  SpannerTypeHint,
} from './type-hints.js';
