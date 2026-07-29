import { entityKind } from 'drizzle-orm/entity';
import type { SpannerTable, SpannerTableWithColumns, TableConfig } from './table.js';

export interface InterleaveConfig {
  onDelete?: 'cascade' | 'noAction';
}

/**
 * Extracts the type-visible primary-key columns of a table — the ones marked
 * with `.primaryKey()` on the column builder. Composite keys declared through
 * `primaryKey({ columns })` carry no type-level marker; those are validated at
 * runtime by `spannerTable` instead.
 */
export type TypeVisiblePkData<T extends TableConfig> = {
  [K in keyof T['columns'] as T['columns'][K]['_']['isPrimaryKey'] extends true
    ? K
    : never]: T['columns'][K]['_']['data'];
};

export class InterleaveBuilder<in TChildColumnsData = any> {
  static readonly [entityKind]: string = 'SpannerInterleaveBuilder';

  /**
   * Compile-time PK-prefix check. The slot is contravariant: assigning this
   * builder into a table's extra config requires the child's column data map
   * to extend the parent's type-visible primary-key data map — i.e. the child
   * must declare every parent PK column with a matching type.
   */
  declare protected $pkPrefixCheck: (childColumnsData: TChildColumnsData) => void;

  constructor(
    readonly parent: SpannerTable,
    readonly config: InterleaveConfig,
  ) {}

  /** @internal */
  build(table: SpannerTable): Interleave {
    return new Interleave(table, this.parent, this.config.onDelete ?? 'noAction');
  }
}

export class Interleave {
  static readonly [entityKind]: string = 'SpannerInterleave';

  constructor(
    readonly table: SpannerTable,
    readonly parent: SpannerTable,
    readonly onDelete: 'cascade' | 'noAction',
  ) {}
}

/**
 * `INTERLEAVE IN PARENT parent ON DELETE { CASCADE | NO ACTION }` — an
 * extra-config entry in the third argument of `spannerTable`. The child
 * primary key must start with the full parent primary key; the types check
 * what they can see and `spannerTable` validates the full name-order prefix
 * at definition time.
 */
export function interleaveInParent<T extends TableConfig>(
  parent: SpannerTableWithColumns<T> | SpannerTable<T>,
  config: InterleaveConfig = {},
): InterleaveBuilder<TypeVisiblePkData<T>> {
  return new InterleaveBuilder(parent as SpannerTable, config);
}
