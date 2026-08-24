import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import type { ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import type { SpannerTable } from '../table.js'
import type { SpannerTypeHint } from '../type-hints.js'
import { SpannerColumn, SpannerColumnBuilder } from './common.js'

export interface SpannerJsonBuilderConfig extends ColumnBuilderBaseConfig<'object json'> {
  data: unknown
  driverParam: string
}

export class SpannerJsonBuilder extends SpannerColumnBuilder<SpannerJsonBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerJsonBuilder'

  constructor(name: string) {
    super(name, 'object json', 'SpannerJson')
  }

  /** @internal */
  build(table: SpannerTable): SpannerJson {
    return new SpannerJson(table, this.config)
  }
}

export class SpannerJson extends SpannerColumn<ColumnBaseConfig<'object json'>> {
  static override readonly [entityKind]: string = 'SpannerJson'

  getSQLType(): string {
    return 'JSON'
  }

  typeHint(): SpannerTypeHint {
    return 'json'
  }

  override mapFromDriverValue = (value: unknown): unknown => {
    if (value === null) return null
    // The driver parses JSON cells already; strings can appear in raw paths.
    return typeof value === 'string' ? JSON.parse(value) : value
  }
}

/** `JSON`. Refine the value type with `.$type<T>()`. */
export function json(name: string): SpannerJsonBuilder {
  return new SpannerJsonBuilder(name)
}
