import { entityKind } from 'drizzle-orm/entity';
import type { SpannerExtraConfigColumn } from './columns/common.js';
import type { SpannerTable } from './table.js';

export type PrimaryKeyColumns = readonly [SpannerExtraConfigColumn, ...SpannerExtraConfigColumn[]];

export interface PrimaryKeyConfig<TColumns extends PrimaryKeyColumns = PrimaryKeyColumns> {
  name?: string;
  columns: TColumns;
}

/** Column keys of a composite primary key, in key order. */
export type PrimaryKeyColumnNames<TColumns extends PrimaryKeyColumns> = {
  [Key in keyof TColumns]: TColumns[Key] extends SpannerExtraConfigColumn<infer TName>
    ? TName
    : never;
};

/** Composite `PRIMARY KEY (...)` — rendered after the column list in Spanner DDL. */
export function primaryKey<const TColumns extends PrimaryKeyColumns>(
  config: PrimaryKeyConfig<TColumns>,
): PrimaryKeyBuilder<PrimaryKeyColumnNames<TColumns>> {
  return new PrimaryKeyBuilder([...config.columns], config.name);
}

/**
 * `TColumnNames` carries the key order of the composite primary key so
 * `interleaveInParent` can check the parent PK prefix at compile time. It is
 * phantom; the runtime key order lives in `columns`.
 */
export class PrimaryKeyBuilder<out TColumnNames extends readonly string[] = readonly string[]> {
  static readonly [entityKind]: string = 'SpannerPrimaryKeyBuilder';

  declare protected $pkColumnNames: TColumnNames;

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
