import { entityKind } from 'drizzle-orm/entity';
import type { SpannerExtraConfigColumn } from './columns/common.js';
import type { SpannerTable } from './table.js';

export interface PrimaryKeyConfig {
  name?: string;
  columns: [SpannerExtraConfigColumn, ...SpannerExtraConfigColumn[]];
}

/** Composite `PRIMARY KEY (...)` — rendered after the column list in Spanner DDL. */
export function primaryKey(config: PrimaryKeyConfig): PrimaryKeyBuilder {
  return new PrimaryKeyBuilder(config.columns, config.name);
}

export class PrimaryKeyBuilder {
  static readonly [entityKind]: string = 'SpannerPrimaryKeyBuilder';

  /** @internal */
  readonly columns: SpannerExtraConfigColumn[];
  /** @internal */
  readonly name: string | undefined;

  constructor(columns: SpannerExtraConfigColumn[], name?: string) {
    this.columns = columns;
    this.name = name;
  }

  /** @internal */
  build(table: SpannerTable): PrimaryKey {
    return new PrimaryKey(table, this.columns, this.name);
  }
}

export class PrimaryKey {
  static readonly [entityKind]: string = 'SpannerPrimaryKey';

  constructor(
    readonly table: SpannerTable,
    readonly columns: SpannerExtraConfigColumn[],
    readonly name: string | undefined,
  ) {}
}
