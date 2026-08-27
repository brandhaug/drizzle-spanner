import { type ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import { type ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import { type SpannerTable } from '../table.js'
import { type SpannerTypeHint } from '../type-hints.js'
import { type SpannerStringLength } from './string.js'
import { SpannerColumn, SpannerColumnBuilder } from './common.js'

export interface SpannerBytesConfig {
  length: SpannerStringLength
}

export interface SpannerBytesBuilderConfig extends ColumnBuilderBaseConfig<'object buffer'> {
  data: Uint8Array
  driverParam: Uint8Array
}

export class SpannerBytesBuilder extends SpannerColumnBuilder<
  SpannerBytesBuilderConfig,
  { length: SpannerStringLength }
> {
  static override readonly [entityKind]: string = 'SpannerBytesBuilder'

  constructor(name: string, config: SpannerBytesConfig) {
    super(name, 'object buffer', 'SpannerBytes')
    this.config.length = config.length
  }

  /** @internal */
  build(table: SpannerTable): SpannerBytes {
    return new SpannerBytes(table, this.config)
  }
}

export class SpannerBytes extends SpannerColumn<
  ColumnBaseConfig<'object buffer'>,
  { length: SpannerStringLength }
> {
  static override readonly [entityKind]: string = 'SpannerBytes'

  getSQLType(): string {
    const { length } = this.config
    return `BYTES(${length === 'max' ? 'MAX' : length})`
  }

  typeHint(): SpannerTypeHint {
    return 'bytes'
  }

  override mapFromDriverValue = (value: unknown): Uint8Array | null => {
    if (value === null) return null
    // The driver decodes BYTES to a Buffer, which is a Uint8Array.
    return value as Uint8Array
  }

  override mapToDriverValue = (value: unknown): Uint8Array => {
    return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
  }
}

/** `BYTES(n | MAX)`. Spanner DDL requires an explicit length. */
export function bytes(name: string, config: SpannerBytesConfig): SpannerBytesBuilder {
  return new SpannerBytesBuilder(name, config)
}
