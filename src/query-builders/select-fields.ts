import { type SQL } from 'drizzle-orm/sql'
import { type SpannerColumn } from '../columns/common.js'

/**
 * The record of fields a select can project. Lives in its own module so
 * `query-base.ts` can reference it without a runtime import of
 * `select.js` — `select.js` extends `SpannerQueryBase`, so a type-only
 * cycle between the two files is still an ESM initialization cycle after
 * the build (inline type imports are emitted as side-effect imports),
 * which crashes on `class SpannerSelect extends SpannerQueryBase`.
 */
export type SpannerSelectedFields = Record<
  string,
  SpannerColumn<any> | SQL | SQL.Aliased
>
