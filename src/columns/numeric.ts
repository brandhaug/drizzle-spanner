import { type ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import { type ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import { type SpannerTable } from '../table.js'
import { type SpannerTypeHint } from '../type-hints.js'
import { SpannerColumn, SpannerColumnBuilder, unwrapDriverWrapper } from './common.js'

export interface SpannerNumericConfig<
  TMode extends 'string' | 'number' = 'string' | 'number'
> {
  mode: TMode
}

/** The driver always returns NUMERIC cells as `Numeric` wrappers `{ value: '3.14' }`. */
function unwrapNumeric(value: unknown): string {
  return String(unwrapDriverWrapper(value))
}

export interface SpannerNumericStringBuilderConfig extends ColumnBuilderBaseConfig<'string numeric'> {
  data: string
  driverParam: string
}

export class SpannerNumericStringBuilder extends SpannerColumnBuilder<SpannerNumericStringBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerNumericStringBuilder'

  constructor(name: string) {
    super(name, 'string numeric', 'SpannerNumericString')
  }

  /** @internal */
  build(table: SpannerTable): SpannerNumericString {
    return new SpannerNumericString(table, this.config)
  }
}

export class SpannerNumericString extends SpannerColumn<
  ColumnBaseConfig<'string numeric'>
> {
  static override readonly [entityKind]: string = 'SpannerNumericString'

  getSQLType(): string {
    return 'NUMERIC'
  }

  typeHint(): SpannerTypeHint {
    return 'numeric'
  }

  override mapFromDriverValue = (value: unknown): string | null => {
    if (value === null) {
      return null
    }
    return unwrapNumeric(value)
  }

  override mapToDriverValue = (value: unknown): string => {
    return String(value)
  }
}

export interface SpannerNumericNumberBuilderConfig extends ColumnBuilderBaseConfig<'number double'> {
  data: number
  driverParam: string
}

export class SpannerNumericNumberBuilder extends SpannerColumnBuilder<SpannerNumericNumberBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerNumericNumberBuilder'

  constructor(name: string) {
    super(name, 'number double', 'SpannerNumericNumber')
  }

  /** @internal */
  build(table: SpannerTable): SpannerNumericNumber {
    return new SpannerNumericNumber(table, this.config)
  }
}

export class SpannerNumericNumber extends SpannerColumn<
  ColumnBaseConfig<'number double'>
> {
  static override readonly [entityKind]: string = 'SpannerNumericNumber'

  getSQLType(): string {
    return 'NUMERIC'
  }

  typeHint(): SpannerTypeHint {
    return 'numeric'
  }

  override mapFromDriverValue = (value: unknown): number | null => {
    if (value === null) {
      return null
    }
    return Number(unwrapNumeric(value))
  }

  override mapToDriverValue = (value: unknown): string => {
    return String(value)
  }
}

/** `NUMERIC` (precision 38, scale 9). Decodes to a lossless string by default; `{ mode: 'number' }` is a lossy opt-in. */
export function numeric(name: string): SpannerNumericStringBuilder
export function numeric(
  name: string,
  config: SpannerNumericConfig<'string'>
): SpannerNumericStringBuilder
export function numeric(
  name: string,
  config: SpannerNumericConfig<'number'>
): SpannerNumericNumberBuilder
export function numeric(
  name: string,
  config?: SpannerNumericConfig
): SpannerNumericStringBuilder | SpannerNumericNumberBuilder {
  return config?.mode === 'number'
    ? new SpannerNumericNumberBuilder(name)
    : new SpannerNumericStringBuilder(name)
}
