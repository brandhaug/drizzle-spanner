import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder';
import type { ColumnBaseConfig } from 'drizzle-orm/column';
import { entityKind } from 'drizzle-orm/entity';
import type { SpannerTable } from '../table.js';
import { SpannerColumn, SpannerColumnBuilder } from './common.js';

export interface SpannerTimestampConfig {
  /** Declares `OPTIONS (allow_commit_timestamp = true)` in DDL; pairs with the `commitTimestamp()` sentinel. */
  allowCommitTimestamp?: boolean;
}

export interface SpannerTimestampBuilderConfig extends ColumnBuilderBaseConfig<'object date'> {
  data: Date;
  driverParam: string;
}

export class SpannerTimestampBuilder extends SpannerColumnBuilder<
  SpannerTimestampBuilderConfig,
  { allowCommitTimestamp: boolean }
> {
  static override readonly [entityKind]: string = 'SpannerTimestampBuilder';

  constructor(name: string, config?: SpannerTimestampConfig) {
    super(name, 'object date', 'SpannerTimestamp');
    this.config.allowCommitTimestamp = config?.allowCommitTimestamp ?? false;
  }

  /** @internal */
  build(table: SpannerTable): SpannerTimestamp {
    return new SpannerTimestamp(table, this.config);
  }
}

export class SpannerTimestamp extends SpannerColumn<
  ColumnBaseConfig<'object date'>,
  { allowCommitTimestamp: boolean }
> {
  static override readonly [entityKind]: string = 'SpannerTimestamp';

  readonly allowCommitTimestamp: boolean;

  constructor(
    table: SpannerTable,
    config: SpannerTimestampBuilder['config'],
  ) {
    super(table, config);
    this.allowCommitTimestamp = config.allowCommitTimestamp;
  }

  getSQLType(): string {
    return 'TIMESTAMP';
  }

  override mapFromDriverValue(value: unknown): Date | null {
    if (value === null) return null;
    // The driver decodes TIMESTAMP to PreciseDate (extends Date); re-wrap to
    // a plain Date so equality against user-constructed dates behaves.
    return value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  }

  override mapToDriverValue(value: unknown): Date {
    return value as Date;
  }
}

/** `TIMESTAMP` — absolute point in time; decodes to a plain `Date`. */
export function timestamp(name: string, config?: SpannerTimestampConfig): SpannerTimestampBuilder {
  return new SpannerTimestampBuilder(name, config);
}
