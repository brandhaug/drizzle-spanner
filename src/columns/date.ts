import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import type { ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import type { SpannerTable } from '../table.js'
import type { SpannerTypeHint } from '../type-hints.js'
import { SpannerColumn, SpannerColumnBuilder } from './common.js'

export interface SpannerDateConfig<
  TMode extends 'string' | 'date' = 'string' | 'date'
> {
  mode: TMode
}

/**
 * The driver decodes DATE to a `SpannerDate` (extends `Date`) pinned to
 * *local* midnight, so read local date components — `toISOString()` would
 * shift the calendar day in timezones east of UTC.
 */
function toIsoDateString(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface SpannerDateStringBuilderConfig extends ColumnBuilderBaseConfig<'string date'> {
  data: string
  driverParam: string
}

export class SpannerDateStringBuilder extends SpannerColumnBuilder<SpannerDateStringBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerDateStringBuilder'

  constructor(name: string) {
    super(name, 'string date', 'SpannerDateString')
  }

  /** @internal */
  build(table: SpannerTable): SpannerDateString {
    return new SpannerDateString(table, this.config)
  }
}

export class SpannerDateString extends SpannerColumn<ColumnBaseConfig<'string date'>> {
  static override readonly [entityKind]: string = 'SpannerDateString'

  getSQLType(): string {
    return 'DATE'
  }

  typeHint(): SpannerTypeHint {
    return 'date'
  }

  override mapFromDriverValue = (value: unknown): string | null => {
    if (value === null) return null
    if (value instanceof Date) return toIsoDateString(value)
    return String(value)
  }

  override mapToDriverValue = (value: unknown): string => {
    return String(value)
  }
}

export interface SpannerDateDateBuilderConfig extends ColumnBuilderBaseConfig<'object date'> {
  data: Date
  driverParam: string
}

export class SpannerDateDateBuilder extends SpannerColumnBuilder<SpannerDateDateBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerDateDateBuilder'

  constructor(name: string) {
    super(name, 'object date', 'SpannerDateDate')
  }

  /** @internal */
  build(table: SpannerTable): SpannerDateDate {
    return new SpannerDateDate(table, this.config)
  }
}

export class SpannerDateDate extends SpannerColumn<ColumnBaseConfig<'object date'>> {
  static override readonly [entityKind]: string = 'SpannerDateDate'

  getSQLType(): string {
    return 'DATE'
  }

  typeHint(): SpannerTypeHint {
    return 'date'
  }

  override mapFromDriverValue = (value: unknown): Date | null => {
    if (value === null) return null
    // Re-wrap SpannerDate into a plain Date at UTC midnight.
    return value instanceof Date
      ? new Date(`${toIsoDateString(value)}T00:00:00Z`)
      : new Date(`${String(value)}T00:00:00Z`)
  }

  override mapToDriverValue = (value: unknown): string => {
    return toIsoDateString(value as Date)
  }
}

/** `DATE` — calendar date without a time zone. Decodes to `YYYY-MM-DD` string by default. */
export function date(name: string): SpannerDateStringBuilder
export function date(
  name: string,
  config: SpannerDateConfig<'string'>
): SpannerDateStringBuilder
export function date(
  name: string,
  config: SpannerDateConfig<'date'>
): SpannerDateDateBuilder
export function date(
  name: string,
  config?: SpannerDateConfig
): SpannerDateStringBuilder | SpannerDateDateBuilder {
  return config?.mode === 'date'
    ? new SpannerDateDateBuilder(name)
    : new SpannerDateStringBuilder(name)
}
