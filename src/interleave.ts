import { entityKind } from 'drizzle-orm/entity';
import type { ForeignKeyAction } from './foreign-keys.js';
import type { PrimaryKeyBuilder } from './primary-keys.js';
import type { SpannerTable, SpannerTableWithColumns, TableConfig } from './table.js';

export interface InterleaveConfig {
  onDelete?: ForeignKeyAction;
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

/**
 * Stands in for a primary-key order the type layer cannot read. It is accepted
 * wherever a parent PK order is expected, which turns the compile-time order
 * check off and leaves that case to the runtime check in `spannerTable`.
 */
export type UnknownPkOrder = readonly ['~unknown primary-key order'];

type IsUnion<T, TAll = T> = T extends TAll ? ([TAll] extends [T] ? false : true) : never;

/**
 * The parent primary key in key order, as far as the types can see it: a
 * single `.primaryKey()` column. A parent whose key is composite — declared
 * through `primaryKey({ columns })`, or spread over several `.primaryKey()`
 * columns — has no type-level key order to read (mapped-type key order is not
 * a language guarantee), so those degrade to `UnknownPkOrder`.
 */
export type TypeVisiblePkOrder<T extends TableConfig> = SingleKeyTuple<
  keyof TypeVisiblePkData<T> & string
>;

type SingleKeyTuple<TKey extends string> = [TKey] extends [never]
  ? UnknownPkOrder
  : string extends TKey
    ? UnknownPkOrder
    : IsUnion<TKey> extends true
      ? UnknownPkOrder
      : [TKey];

/** Every non-empty prefix of a key order, as a union. */
type PkPrefixes<TNames extends readonly string[]> = TNames extends readonly [
  ...infer THead extends readonly string[],
  string,
]
  ? TNames | PkPrefixes<THead>
  : never;

/**
 * Parent key orders a child's extra-config entries admit: the child primary
 * key must start with the full parent primary key, so any prefix of the
 * child's key order is a legal parent key order.
 *
 * Falls back to "any order" — no compile-time check — when the child's key
 * order is not type-visible: no `primaryKey({ columns })` entry (the key comes
 * from `.primaryKey()` column markers, whose order the types cannot read), or
 * a `columns` argument that is not a fixed tuple.
 */
export type AdmissiblePkOrder<TEntries> =
  Extract<TEntries, PrimaryKeyBuilder> extends PrimaryKeyBuilder<
    infer TNames extends readonly string[]
  >
    ? [Extract<TEntries, PrimaryKeyBuilder>] extends [never]
      ? readonly string[]
      : [PkPrefixes<TNames>] extends [never]
        ? readonly string[]
        : PkPrefixes<TNames> | UnknownPkOrder
    : readonly string[];

export class InterleaveBuilder<
  in TChildColumnsData = any,
  out TParentPkOrder extends readonly string[] = readonly string[],
> {
  static readonly [entityKind]: string = 'SpannerInterleaveBuilder';

  /**
   * Compile-time PK-prefix check. The slot is contravariant: assigning this
   * builder into a table's extra config requires the child's column data map
   * to extend the parent's type-visible primary-key data map — i.e. the child
   * must declare every parent PK column with a matching type.
   */
  declare protected $pkPrefixCheck: (childColumnsData: TChildColumnsData) => void;

  /**
   * Compile-time PK-order check, phantom like the one above. The extra-config
   * slot admits only the prefixes of the child's own key order, so a child
   * that declares the parent PK columns in the wrong order — or too late in
   * the key — fails to assign. Either side degrading to `UnknownPkOrder`
   * (see `TypeVisiblePkOrder` and `AdmissiblePkOrder`) turns the check off.
   */
  declare protected $parentPkOrder: TParentPkOrder;

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
    readonly onDelete: ForeignKeyAction,
  ) {}
}

/**
 * `INTERLEAVE IN PARENT parent ON DELETE { CASCADE | NO ACTION }` — an
 * extra-config entry in the third argument of `spannerTable`. The child
 * primary key must start with the full parent primary key: the types check
 * that the child declares the parent PK columns with matching types, and — as
 * far as both key orders are type-visible — that it declares them in the
 * parent's key order. `spannerTable` validates the full name-order prefix at
 * definition time, including the cases the types cannot see.
 */
export function interleaveInParent<T extends TableConfig>(
  parent: SpannerTableWithColumns<T> | SpannerTable<T>,
  config: InterleaveConfig = {},
): InterleaveBuilder<TypeVisiblePkData<T>, TypeVisiblePkOrder<T>> {
  return new InterleaveBuilder(parent as SpannerTable, config);
}
