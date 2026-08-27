import { type ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder'
import { type ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import { type SpannerTable } from '../table.js'
import { type SpannerTypeHint } from '../type-hints.js'
import { SpannerColumn, SpannerColumnBuilder } from './common.js'

export interface SpannerTokenlistBuilderConfig extends ColumnBuilderBaseConfig<'custom'> {
  data: unknown
  driverParam: never
}

export class SpannerTokenlistBuilder extends SpannerColumnBuilder<SpannerTokenlistBuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerTokenlistBuilder'

  constructor(name: string) {
    super(name, 'custom', 'SpannerTokenlist')
  }

  /** @internal */
  build(table: SpannerTable): SpannerTokenlist {
    return new SpannerTokenlist(table, this.config)
  }
}

export class SpannerTokenlist extends SpannerColumn<ColumnBaseConfig<'custom'>> {
  static override readonly [entityKind]: string = 'SpannerTokenlist'

  getSQLType(): string {
    return 'TOKENLIST'
  }

  typeHint(): SpannerTypeHint {
    // TOKENLIST values cannot be bound as parameters; they only exist as
    // generated columns feeding search indexes.
    return 'none'
  }
}

/**
 * `TOKENLIST` — the search-index token column. Always paired with
 * `.generatedAlwaysAs(sql`TOKENIZE_FULLTEXT(...)`)`; the value is not
 * readable or writable through DML.
 */
export function tokenlist(name: string): SpannerTokenlistBuilder {
  return new SpannerTokenlistBuilder(name)
}
