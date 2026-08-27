import { type ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import { type ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import { type SpannerTable } from '../table.js'
import { type SpannerTypeHint } from '../type-hints.js'
import { SpannerColumnBuilder, SpannerFloatColumn } from './common.js'

export interface SpannerFloat64BuilderConfig extends ColumnBuilderBaseConfig<'number double'> {
  data: number
  driverParam: number
}

export class SpannerFloat64Builder extends SpannerColumnBuilder<SpannerFloat64BuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerFloat64Builder'

  constructor(name: string) {
    super(name, 'number double', 'SpannerFloat64')
  }

  /** @internal */
  build(table: SpannerTable): SpannerFloat64 {
    return new SpannerFloat64(table, this.config)
  }
}

export class SpannerFloat64 extends SpannerFloatColumn<
  ColumnBaseConfig<'number double'>
> {
  static override readonly [entityKind]: string = 'SpannerFloat64'

  getSQLType(): string {
    return 'FLOAT64'
  }

  typeHint(): SpannerTypeHint {
    return 'float64'
  }
}

/** `FLOAT64` — double precision, supports NaN and infinity. */
export function float64(name: string): SpannerFloat64Builder {
  return new SpannerFloat64Builder(name)
}
