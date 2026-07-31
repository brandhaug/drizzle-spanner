import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import type { ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import type { SpannerTable } from '../table.js'
import type { SpannerTypeHint } from '../type-hints.js'
import { SpannerColumn, SpannerColumnBuilder } from './common.js'

export interface SpannerBoolBuilderConfig extends ColumnBuilderBaseConfig<'boolean'> {
  data: boolean
  driverParam: boolean
}

export class SpannerBoolBuilder extends SpannerColumnBuilder<SpannerBoolBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerBoolBuilder'

  constructor(name: string) {
    super(name, 'boolean', 'SpannerBool')
  }

  /** @internal */
  build(table: SpannerTable): SpannerBool {
    return new SpannerBool(table, this.config)
  }
}

export class SpannerBool extends SpannerColumn<ColumnBaseConfig<'boolean'>> {
  static override readonly [entityKind]: string = 'SpannerBool'

  getSQLType(): string {
    return 'BOOL'
  }

  typeHint(): SpannerTypeHint {
    return 'bool'
  }
}

/** `BOOL`. */
export function bool(name: string): SpannerBoolBuilder {
  return new SpannerBoolBuilder(name)
}
