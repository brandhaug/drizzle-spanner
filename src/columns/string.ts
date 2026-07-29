import type { ColumnBuilderBaseConfig, HasDefault } from 'drizzle-orm/column-builder';
import type { ColumnBaseConfig } from 'drizzle-orm/column';
import { entityKind } from 'drizzle-orm/entity';
import { sql } from 'drizzle-orm/sql';
import type { SpannerTable } from '../table.js';
import { SpannerColumn, SpannerColumnBuilder } from './common.js';

export type SpannerStringLength = number | 'max';

export interface SpannerStringConfig {
  length: SpannerStringLength;
}

export interface SpannerStringBuilderConfig extends ColumnBuilderBaseConfig<'string'> {
  data: string;
  driverParam: string;
}

export class SpannerStringBuilder extends SpannerColumnBuilder<
  SpannerStringBuilderConfig,
  { length: SpannerStringLength }
> {
  static override readonly [entityKind]: string = 'SpannerStringBuilder';

  constructor(name: string, config: SpannerStringConfig) {
    super(name, 'string', 'SpannerString');
    this.config.length = config.length;
  }

  /** DDL default `GENERATE_UUID()` — the recommended Spanner primary-key strategy. */
  defaultGenerateUuid(): HasDefault<this> {
    return this.default(sql`GENERATE_UUID()`);
  }

  /** @internal */
  build(table: SpannerTable): SpannerString {
    return new SpannerString(table, this.config);
  }
}

export class SpannerString extends SpannerColumn<
  ColumnBaseConfig<'string'>,
  { length: SpannerStringLength }
> {
  static override readonly [entityKind]: string = 'SpannerString';

  getSQLType(): string {
    const { length } = this.config;
    return `STRING(${length === 'max' ? 'MAX' : length})`;
  }
}

/** `STRING(n | MAX)`. Spanner DDL requires an explicit length. */
export function string(name: string, config: SpannerStringConfig): SpannerStringBuilder {
  return new SpannerStringBuilder(name, config);
}
