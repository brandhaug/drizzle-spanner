import { describe, expect, it } from 'bun:test'

import * as root from '../../src/index.js'
import * as internal from '../../src/internal.js'

// The hardening audit's contract: everything exported from the package root
// is intentional public API. Wiring helpers the adapter and the kit share
// live under drizzle-spanner/internal instead, with no stability promise.
const INTERNAL_HELPERS = [
  'MUTATION_MODE_READ_MESSAGE',
  'MUTATION_MODE_RETURNING_MESSAGE',
  'NO_CLIENT_MESSAGE',
  'arrayTypeHint',
  'createDatabaseSession',
  'createMockSession',
  'driverRowToObject',
  'getPrimaryKeyColumns',
  'getTableExtraConfig',
  'mapRowToParams',
  'toDriverParamType',
  'toMutationRow',
  'toNamedParams',
  'toTimestampBounds',
  'unwrapDriverWrapper',
  'unwrapFloat',
  'whereToPrimaryKey',
  'wrapSpannerError'
]

const PUBLIC_EXPORTS = [
  'CheckBuilder',
  'ForeignKeyBuilder',
  'GrpcStatus',
  'Index',
  'IndexBuilder',
  'IndexBuilderOn',
  'IndexedColumn',
  'Interleave',
  'InterleaveBuilder',
  'PrimaryKey',
  'PrimaryKeyBuilder',
  'SpannerAbortedError',
  'SpannerArray',
  'SpannerArrayBuilder',
  'SpannerBool',
  'SpannerBoolBuilder',
  'SpannerBytes',
  'SpannerBytesBuilder',
  'SpannerColumn',
  'SpannerColumnBuilder',
  'SpannerConstraintError',
  'SpannerDatabase',
  'SpannerDatabaseCore',
  'SpannerDateDate',
  'SpannerDateDateBuilder',
  'SpannerDateString',
  'SpannerDateStringBuilder',
  'SpannerDdlError',
  'SpannerDelete',
  'SpannerDialect',
  'SpannerDmlBase',
  'SpannerError',
  'SpannerExtraConfigColumn',
  'SpannerFilteredDmlBase',
  'SpannerFloat32',
  'SpannerFloat32Builder',
  'SpannerFloat64',
  'SpannerFloat64Builder',
  'SpannerFloatColumn',
  'SpannerInsert',
  'SpannerInsertBuilder',
  'SpannerInt64BigInt',
  'SpannerInt64BigIntBuilder',
  'SpannerInt64Number',
  'SpannerInt64NumberBuilder',
  'SpannerInvalidArgumentError',
  'SpannerJson',
  'SpannerJsonBuilder',
  'SpannerNumericNumber',
  'SpannerNumericNumberBuilder',
  'SpannerNumericString',
  'SpannerNumericStringBuilder',
  'SpannerPrecisionError',
  'SpannerPreparedQuery',
  'SpannerQueryBase',
  'SpannerRelationalQuery',
  'SpannerRelationalQueryBuilder',
  'SpannerSelect',
  'SpannerSelectBuilder',
  'SpannerSequence',
  'SpannerSession',
  'SpannerString',
  'SpannerStringBuilder',
  'SpannerTable',
  'SpannerTimestamp',
  'SpannerTimestampBuilder',
  'SpannerTokenlist',
  'SpannerTokenlistBuilder',
  'SpannerTransaction',
  'SpannerUnavailableError',
  'SpannerUpdate',
  'SpannerUpdateBuilder',
  'bool',
  'bytes',
  'check',
  'commitTimestamp',
  'date',
  'drizzle',
  'float32',
  'float64',
  'foreignKey',
  'index',
  'int64',
  'interleaveInParent',
  'json',
  'numeric',
  'primaryKey',
  'sequence',
  'spannerTable',
  'string',
  'timestamp',
  'tokenlist',
  'uniqueIndex'
]

describe('drizzle-spanner public API surface', () => {
  it('the package root exports exactly the audited public names', () => {
    expect(Object.keys(root).toSorted()).toEqual(PUBLIC_EXPORTS)
  })

  it('internal helpers are available from drizzle-spanner/internal', () => {
    for (const name of INTERNAL_HELPERS) {
      expect(internal, name).toHaveProperty(name)
    }
  })
})
