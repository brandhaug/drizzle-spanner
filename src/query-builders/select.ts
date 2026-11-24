import { entityKind, is } from 'drizzle-orm/entity'
import { type Query, type SQL } from 'drizzle-orm/sql'
import { type Column, type GetColumnData } from 'drizzle-orm/column'
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy'
import { Subquery } from 'drizzle-orm/subquery'
import { getTableName, type InferSelectModel } from 'drizzle-orm/table'
import { type SpannerColumn } from '../columns/common.js'
import {
  type SpannerConditionalJoinType,
  type SpannerDialect,
  type SpannerJoin,
  type SpannerJoinType,
  type SpannerSelectConfig,
  type SpannerSetOperationConfig,
  type SpannerSetOperator
} from '../dialect.js'
import { SpannerInvalidArgumentError } from '../errors.js'
import { type SelectedFieldsOrdered } from '../orm-internal.js'
import {
  makeDefaultQueryMapper,
  orderSelectedFields,
  resolveNullableObjectPaths
} from '../orm-internal.js'
import { type SpannerRequestOptions, type SpannerSession } from '../session.js'
import { type SpannerStaleness } from '../staleness.js'
import { toTimestampBounds } from '../staleness.js'
import { type AnySpannerTable } from '../table.js'
import { TableColumns } from '../symbols.js'
import { type SpannerRequestState, SpannerQueryBase } from './query-base.js'
import { type SpannerSelectedFields } from './select-fields.js'

export type { SpannerSelectedFields } from './select-fields.js'

declare const subqueryField: unique symbol

/**
 * Type-only mark on a subquery's field: the alias that qualifies it, whether a
 * join inside the subquery can make it null, and the field it reads. A join
 * that makes the subquery nullable makes the field nullable.
 */
interface SubqueryFieldMark<TAlias extends string, TNullable extends boolean, TField> {
  readonly [subqueryField]: { alias: TAlias; nullable: TNullable; field: TField }
}

/** The field a subquery field reads, through any number of nested subqueries. */
type UnmarkedField<TField> =
  TField extends SubqueryFieldMark<string, boolean, infer TInner> ? TInner : TField

type MarkedNullable<TField> =
  TField extends SubqueryFieldMark<string, infer TNullable, unknown> ? TNullable : false

type FieldData<T> =
  T extends Column<any>
    ? GetColumnData<T>
    : T extends SQL.Aliased<infer U>
      ? U
      : T extends SQL<infer U>
        ? U
        : never

export type SelectResultField<T> =
  MarkedNullable<T> extends true ? FieldData<T> | null : FieldData<T>

export type SelectResultFields<TSelection> = {
  [Key in keyof TSelection]: SelectResultField<TSelection[Key]>
} & {}

/** Whether a join can leave a table without a row. */
type JoinNullability = 'nullable' | 'not-null'

type ApplyNullability<
  T,
  TNullability extends JoinNullability
> = TNullability extends 'nullable' ? T | null : T

type SetNullability<
  TNullability extends Record<string, JoinNullability>,
  TValue extends JoinNullability
> = { [Key in keyof TNullability]: TValue }

/**
 * Nullability after a join, as drizzle's dialects track it: a left join can
 * leave the joined table without a row, a right join every earlier table, and
 * a full join any table.
 */
type AppendToNullabilityMap<
  TNullability extends Record<string, JoinNullability>,
  TJoinedName extends string,
  TJoinType extends SpannerJoinType
> = TJoinType extends 'left'
  ? TNullability & Record<TJoinedName, 'nullable'>
  : TJoinType extends 'right'
    ? SetNullability<TNullability, 'nullable'> & Record<TJoinedName, 'not-null'>
    : TJoinType extends 'full'
      ? SetNullability<TNullability, 'nullable'> & Record<TJoinedName, 'nullable'>
      : TNullability & Record<TJoinedName, 'not-null'>

/**
 * A subquery's field: the selected field, marked in its type with the
 * subquery's alias and with whether the subquery can read it as null.
 */
export type SpannerSubqueryField<
  TField,
  TAlias extends string,
  TNullable extends boolean = false
> = UnmarkedField<TField> & SubqueryFieldMark<TAlias, TNullable, UnmarkedField<TField>>

type SubquerySelection<
  TSelection,
  TAlias extends string,
  TNullability extends Record<string, JoinNullability>
> = {
  [Key in keyof TSelection]: SpannerSubqueryField<
    TSelection[Key],
    TAlias,
    MarkedNullable<TSelection[Key]> extends true
      ? true
      : JoinNullable<TSelection[Key], TNullability>
  >
}

/**
 * A select used as a table: `db.select().from(sq)` or a join, with each
 * selected field readable as `sq.<key>` and qualified by the alias.
 * `TNullability` is the join nullability of the select it was made from.
 */
export type SpannerSubquery<
  TSelection extends Record<string, unknown> = Record<string, unknown>,
  TAlias extends string = string,
  TNullability extends Record<string, JoinNullability> = Record<string, 'not-null'>
> = Subquery<TAlias, SubquerySelection<TSelection, TAlias, TNullability>> &
  SubquerySelection<TSelection, TAlias, TNullability>

/** What a select can read from or join: a table, or a subquery by its alias. */
type SpannerFromItem = AnySpannerTable | Subquery

type FromItemName<TItem> = TItem extends AnySpannerTable
  ? TItem['_']['name']
  : TItem extends Subquery<infer TAlias>
    ? TAlias
    : never

type FromItemSelection<TItem> = TItem extends AnySpannerTable
  ? TItem['_']['columns']
  : TItem extends Subquery<string, infer TSelection>
    ? TSelection
    : never

/**
 * The join bookkeeping a select carries in its type. `mode` is `partial` when
 * the select names its fields, `single` for whole rows of one table, and
 * `multiple` for whole rows of each joined table, keyed by name. `nullability`
 * says which tables a join can leave without a row.
 */
export interface SpannerJoinState {
  tableName: string
  mode: 'partial' | 'single' | 'multiple'
  nullability: Record<string, JoinNullability>
}

type FromJoinState<TSelection, TItem> = {
  tableName: FromItemName<TItem>
  mode: TSelection extends SpannerSelectedFields ? 'partial' : 'single'
  nullability: Record<FromItemName<TItem>, 'not-null'>
}

/** The table or subquery whose join nullability a field takes; never for SQL of no table. */
type FieldSource<TField> =
  TField extends SubqueryFieldMark<infer TAlias, boolean, unknown>
    ? TAlias
    : TField extends Column<any>
      ? TField['_']['tableName']
      : never

/** Whether a join leaves the field's table or subquery without a row. */
type JoinNullable<TField, TNullability extends Record<string, JoinNullability>> = [
  FieldSource<TField>
] extends [never]
  ? false
  : FieldSource<TField> extends keyof TNullability
    ? TNullability[FieldSource<TField>] extends 'nullable'
      ? true
      : false
    : false

type PartialJoinResult<
  TSelection,
  TNullability extends Record<string, JoinNullability>
> = {
  [Key in keyof TSelection]: JoinNullable<TSelection[Key], TNullability> extends true
    ? SelectResultField<TSelection[Key]> | null
    : SelectResultField<TSelection[Key]>
} & {}

type MultipleJoinResult<
  TSelection,
  TNullability extends Record<string, JoinNullability>
> = {
  [Key in keyof TSelection]: ApplyNullability<
    SelectResultFields<TSelection[Key]>,
    Key extends keyof TNullability ? TNullability[Key] : 'not-null'
  >
} & {}

type JoinedState<
  TJoin extends SpannerJoinState,
  TItem extends SpannerFromItem,
  TJoinType extends SpannerJoinType
> = {
  tableName: TJoin['tableName']
  mode: TJoin['mode'] extends 'partial' ? 'partial' : 'multiple'
  nullability: AppendToNullabilityMap<
    TJoin['nullability'],
    FromItemName<TItem>,
    TJoinType
  >
}

type JoinedSelection<
  TSelection extends Record<string, unknown>,
  TJoin extends SpannerJoinState,
  TItem extends SpannerFromItem
> = TJoin['mode'] extends 'partial'
  ? TSelection
  : {
      [
        Key in
          | keyof (TJoin['mode'] extends 'single'
              ? Record<TJoin['tableName'], TSelection>
              : TSelection)
          | FromItemName<TItem>
      ]: Key extends FromItemName<TItem>
        ? FromItemSelection<TItem>
        : TJoin['mode'] extends 'single'
          ? TSelection
          : Key extends keyof TSelection
            ? TSelection[Key]
            : never
    }

type JoinedResult<
  TSelection,
  TJoin extends SpannerJoinState
> = TJoin['mode'] extends 'partial'
  ? PartialJoinResult<TSelection, TJoin['nullability']>
  : MultipleJoinResult<TSelection, TJoin['nullability']>

/**
 * A join condition: SQL, or a callback that receives the selection after the
 * join (each joined table's columns by name, or the named fields).
 */
export type SpannerJoinCondition<TFields> = SQL | ((fields: TFields) => SQL | undefined)

/** The join a select or transaction select takes: what it joins, and how. */
type JoinedSelect<
  TSelection extends Record<string, unknown>,
  TJoin extends SpannerJoinState,
  TItem extends SpannerFromItem,
  TJoinType extends SpannerJoinType
> = {
  selection: JoinedSelection<TSelection, TJoin, TItem>
  join: JoinedState<TJoin, TItem, TJoinType>
  result: JoinedResult<
    JoinedSelection<TSelection, TJoin, TItem>,
    JoinedState<TJoin, TItem, TJoinType>
  >
}

/** The select a join returns: its selection, join state and row type after the join. */
export type SpannerJoinedSelect<
  TSelection extends Record<string, unknown>,
  TJoin extends SpannerJoinState,
  TItem extends SpannerFromItem,
  TJoinType extends SpannerJoinType,
  TJoined extends JoinedSelect<TSelection, TJoin, TItem, TJoinType> = JoinedSelect<
    TSelection,
    TJoin,
    TItem,
    TJoinType
  >
> = SpannerSelect<TJoined['result'], TJoined['selection'], TJoined['join']>

/** `SpannerJoinedSelect` inside a transaction. */
export type SpannerTransactionJoinedSelect<
  TSelection extends Record<string, unknown>,
  TJoin extends SpannerJoinState,
  TItem extends SpannerFromItem,
  TJoinType extends SpannerJoinType,
  TJoined extends JoinedSelect<TSelection, TJoin, TItem, TJoinType> = JoinedSelect<
    TSelection,
    TJoin,
    TItem,
    TJoinType
  >
> = SpannerTransactionSelect<TJoined['result'], TJoined['selection'], TJoined['join']>

type SelectionOf<
  TSelection extends SpannerSelectedFields | undefined,
  TTable
> = TSelection extends SpannerSelectedFields
  ? TSelection
  : TTable extends AnySpannerTable
    ? TTable['_']['columns']
    : TTable extends Subquery<string, infer S>
      ? S
      : never

type ResultOf<
  TSelection extends SpannerSelectedFields | undefined,
  TTable
> = TSelection extends SpannerSelectedFields
  ? SelectResultFields<TSelection>
  : TTable extends AnySpannerTable
    ? InferSelectModel<TTable>
    : TTable extends Subquery<string, infer S>
      ? SelectResultFields<S>
      : never

/** What a set operator takes on its right: a select (or compound) of the same row type. */
export interface SpannerSetOperand<TResult> {
  readonly _: { readonly result: Array<TResult> }
  getSQL(): SQL
}

/**
 * The select surface inside a transaction: everything `SpannerSelect` offers
 * except `withStaleness` and `withSignal` — a single-use bounded read cannot
 * run on an open transaction, and a callback the driver retries cannot be
 * cancelled one read at a time, so both are omitted from the type (spec:
 * runtime API).
 */
export interface SpannerTransactionSelect<
  TResult,
  TSelection extends Record<string, unknown> = Record<string, unknown>,
  TJoin extends SpannerJoinState = SpannerJoinState
> extends PromiseLike<Array<TResult>> {
  innerJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerTransactionJoinedSelect<TSelection, TJoin, TItem, 'inner'>
  leftJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerTransactionJoinedSelect<TSelection, TJoin, TItem, 'left'>
  rightJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerTransactionJoinedSelect<TSelection, TJoin, TItem, 'right'>
  fullJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerTransactionJoinedSelect<TSelection, TJoin, TItem, 'full'>
  crossJoin<TItem extends SpannerFromItem>(
    item: TItem
  ): SpannerTransactionJoinedSelect<TSelection, TJoin, TItem, 'cross'>
  where(where: SQL | undefined): this
  groupBy(...groupBy: Array<SpannerColumn<any> | SQL | SQL.Aliased>): this
  having(having: SQL | undefined): this
  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this
  limit(limit: number): this
  offset(offset: number): this
  withRequestOptions(options: SpannerRequestOptions): this
  toSQL(): Query
  execute(): Promise<Array<TResult>>
}

export interface SpannerTransactionSelectBuilder<
  TSelection extends SpannerSelectedFields | undefined
> {
  from<TTable extends SpannerFromItem>(
    table: TTable
  ): SpannerTransactionSelect<
    ResultOf<TSelection, TTable>,
    SelectionOf<TSelection, TTable>,
    FromJoinState<TSelection, TTable>
  >
}

export class SpannerSelectBuilder<
  TSelection extends SpannerSelectedFields | undefined
> {
  static readonly [entityKind]: string = 'SpannerSelectBuilder'

  constructor(
    private readonly fields: TSelection,
    private readonly session: SpannerSession | undefined,
    private readonly dialect: SpannerDialect
  ) {}

  from<TTable extends SpannerFromItem>(
    table: TTable
  ): SpannerSelect<
    ResultOf<TSelection, TTable>,
    SelectionOf<TSelection, TTable>,
    FromJoinState<TSelection, TTable>
  > {
    return new SpannerSelect(
      table,
      this.fields ?? fromItemFields(table),
      this.fields !== undefined,
      this.session,
      this.dialect
    )
  }
}

/** A table's columns, or a subquery's fields read through its proxy so its alias qualifies each. */
function fromItemFields(item: SpannerFromItem): Record<string, unknown> {
  if (is(item, Subquery)) {
    return Object.fromEntries(
      Object.keys(item._.selectedFields).map((key) => [
        key,
        (item as unknown as Record<string, unknown>)[key]
      ])
    )
  }
  return item[TableColumns]
}

function fromItemName(item: SpannerFromItem): string {
  return is(item, Subquery) ? item._.alias : getTableName(item)
}

/** A read on the database: a select or a compound select, which combine by set operators and can be cancelled. */
abstract class SpannerReadQuery<TResult> extends SpannerQueryBase<Array<TResult>> {
  static override readonly [entityKind]: string = 'SpannerReadQuery'

  protected abstract setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult>

  /** `UNION ALL`: every row of both selects. */
  unionAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('union', true, right)
  }

  /** `UNION DISTINCT`: GoogleSQL has no bare `UNION`. */
  union(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('union', false, right)
  }

  intersect(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('intersect', false, right)
  }

  intersectAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('intersect', true, right)
  }

  except(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('except', false, right)
  }

  exceptAll(right: SpannerSetOperand<TResult>): SpannerSetOperation<TResult> {
    return this.setOperation('except', true, right)
  }

  /** Cancels the read when the signal aborts; the query rejects with the signal's reason. */
  withSignal(signal: AbortSignal): this {
    this.requestState = { ...this.requestState, signal }
    return this
  }
}

export class SpannerSelect<
  TResult,
  TSelection extends Record<string, unknown> = Record<string, unknown>,
  TJoin extends SpannerJoinState = SpannerJoinState
> extends SpannerReadQuery<TResult> {
  static override readonly [entityKind]: string = 'SpannerSelect'

  private readonly config: SpannerSelectConfig
  private readonly tableName: string
  /** Whether each table read so far always has a row; a join can take that away. */
  private joinsNotNullable: Record<string, boolean>

  constructor(
    table: SpannerFromItem,
    fields: Record<string, unknown>,
    private readonly isPartialSelect: boolean,
    session: SpannerSession | undefined,
    dialect: SpannerDialect
  ) {
    super(session, dialect, 'select')
    this.config = { table, fields }
    this.tableName = fromItemName(table)
    this.joinsNotNullable = { [this.tableName]: true }
  }

  private joinCondition(on: SpannerJoinCondition<never>): SQL {
    if (typeof on !== 'function') {
      return on
    }
    // The fields as selected: a subquery's fields already read through its alias.
    const condition = (on as (fields: unknown) => SQL | undefined)(this.config.fields)
    if (!condition) {
      throw new SpannerInvalidArgumentError({
        message:
          'The join condition callback returned no condition; use crossJoin to pair every row'
      })
    }
    return condition
  }

  /** `inner join`: rows of both sides that match `on`. */
  innerJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerJoinedSelect<TSelection, TJoin, TItem, 'inner'> {
    return this.join(item, { joinType: 'inner', on })
  }

  /** `left join`: a row with no match on the right reads the right side as null. */
  leftJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerJoinedSelect<TSelection, TJoin, TItem, 'left'> {
    return this.join(item, { joinType: 'left', on })
  }

  /** `right join`: a row with no match on the left reads every earlier table as null. */
  rightJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerJoinedSelect<TSelection, TJoin, TItem, 'right'> {
    return this.join(item, { joinType: 'right', on })
  }

  /** `full join`: either side can be null. */
  fullJoin<TItem extends SpannerFromItem>(
    item: TItem,
    on: SpannerJoinCondition<JoinedSelection<TSelection, TJoin, TItem>>
  ): SpannerJoinedSelect<TSelection, TJoin, TItem, 'full'> {
    return this.join(item, { joinType: 'full', on })
  }

  /** `cross join`: every row of the left with every row of the right. */
  crossJoin<TItem extends SpannerFromItem>(
    item: TItem
  ): SpannerJoinedSelect<TSelection, TJoin, TItem, 'cross'> {
    return this.join(item, { joinType: 'cross' })
  }

  private join<TJoined>(
    item: SpannerFromItem,
    how:
      | { joinType: 'cross' }
      | { joinType: SpannerConditionalJoinType; on: SpannerJoinCondition<never> }
  ): TJoined {
    const name = fromItemName(item)
    if (name in this.joinsNotNullable) {
      throw new SpannerInvalidArgumentError({
        message: `"${name}" is already used in this query; a table read twice needs a subquery under another alias`
      })
    }
    if (!this.isPartialSelect) {
      // Whole rows of each table, keyed by name, once there is more than one table.
      if (!this.config.joins) {
        this.config.fields = { [this.tableName]: this.config.fields }
      }
      this.config.fields[name] = fromItemFields(item)
    }
    const join: SpannerJoin =
      how.joinType === 'cross'
        ? { table: item, joinType: 'cross' }
        : { table: item, joinType: how.joinType, on: this.joinCondition(how.on) }
    this.config.joins = [...(this.config.joins ?? []), join]
    if (how.joinType === 'right' || how.joinType === 'full') {
      for (const joined of Object.keys(this.joinsNotNullable)) {
        this.joinsNotNullable[joined] = false
      }
    }
    this.joinsNotNullable[name] = how.joinType !== 'left' && how.joinType !== 'full'
    return this as unknown as TJoined
  }

  where(where: SQL | undefined): this {
    this.config.where = where
    return this
  }

  groupBy(...groupBy: Array<SpannerColumn<any> | SQL | SQL.Aliased>): this {
    this.config.groupBy = groupBy
    return this
  }

  having(having: SQL | undefined): this {
    this.config.having = having
    return this
  }

  /**
   * Turns the query into a single-use bounded read at the given staleness.
   * Only available on the database — inside any transaction it is omitted
   * from the select type and the session throws a typed error as backstop.
   */
  withStaleness(staleness: SpannerStaleness): this {
    this.requestState = {
      ...this.requestState,
      staleness: toTimestampBounds(staleness)
    }
    return this
  }

  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this {
    this.config.orderBy = orderBy
    return this
  }

  limit(limit: number): this {
    this.config.limit = limit
    return this
  }

  offset(offset: number): this {
    this.config.offset = offset
    return this
  }

  /** This select as a table named `alias`, for `db.select().from(...)`. */
  as<TAlias extends string>(
    alias: TAlias
  ): SpannerSubquery<TSelection, TAlias, TJoin['nullability']> {
    if (this.config.joins && !this.isPartialSelect) {
      throw new SpannerInvalidArgumentError({
        message: `Subquery "${alias}" would select whole rows of joined tables, whose column names can repeat; name the fields it selects`
      })
    }
    return new Proxy(
      new Subquery(this.getSQL(), this.config.fields, alias),
      new SelectionProxyHandler({
        alias,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error'
      })
    ) as unknown as SpannerSubquery<TSelection, TAlias, TJoin['nullability']>
  }

  protected setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult> {
    return new SpannerSetOperation<TResult>(
      { left: this, operations: [{ operator, all, right }] },
      this.config.fields,
      this.session,
      this.dialect,
      this.requestState,
      this.nullableObjectPaths(this.selection())
    )
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSelectQuery(this.config)
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.config.fields)
  }

  protected override rowsMapper(
    fields: SelectedFieldsOrdered
  ): ((rows: Array<Array<unknown>>) => Array<TResult>) | undefined {
    return joinedRowsMapper(fields, this.nullableObjectPaths(fields))
  }

  /**
   * The selection paths that read as null when all their fields are: the
   * nullable joined tables. In whole rows each table is its own path, whatever
   * its fields are; a partial select's nested objects are matched to tables by
   * their columns. Undefined until the select joins.
   */
  private nullableObjectPaths(
    fields: SelectedFieldsOrdered
  ): Array<string> | undefined {
    if (!this.config.joins) {
      return undefined
    }
    if (this.isPartialSelect) {
      return resolveNullableObjectPaths(fields, this.joinsNotNullable)
    }
    return Object.keys(this.joinsNotNullable).filter(
      (name) => !this.joinsNotNullable[name]
    )
  }
}

/** A nullable joined table reads as null, not as an object of nulls, when it has no row. */
function joinedRowsMapper<TResult>(
  fields: SelectedFieldsOrdered,
  nullableObjectPaths: Array<string> | undefined
): ((rows: Array<Array<unknown>>) => Array<TResult>) | undefined {
  if (!nullableObjectPaths) {
    return undefined
  }
  return makeDefaultQueryMapper<TResult>(fields, nullableObjectPaths)
}

/**
 * Selects joined by set operators. `orderBy`, `limit` and `offset` apply to
 * the combined rows; a column in `orderBy` names the output column.
 */
export class SpannerSetOperation<TResult> extends SpannerReadQuery<TResult> {
  static override readonly [entityKind]: string = 'SpannerSetOperation'

  constructor(
    private readonly config: SpannerSetOperationConfig,
    private readonly fields: Record<string, unknown>,
    session: SpannerSession | undefined,
    dialect: SpannerDialect,
    requestState: SpannerRequestState,
    /** The first select's nullable joined tables: its rows map as the combined rows do. */
    private readonly nullableObjectPaths: Array<string> | undefined
  ) {
    super(session, dialect, 'select', requestState)
  }

  orderBy(...orderBy: Array<SpannerColumn<any> | SQL>): this {
    this.config.orderBy = orderBy
    return this
  }

  limit(limit: number): this {
    this.config.limit = limit
    return this
  }

  offset(offset: number): this {
    this.config.offset = offset
    return this
  }

  protected setOperation(
    operator: SpannerSetOperator,
    all: boolean,
    right: SpannerSetOperand<TResult>
  ): SpannerSetOperation<TResult> {
    return new SpannerSetOperation<TResult>(
      {
        ...this.config,
        operations: [...this.config.operations, { operator, all, right }]
      },
      this.fields,
      this.session,
      this.dialect,
      this.requestState,
      this.nullableObjectPaths
    )
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSetOperationQuery(this.config)
  }

  protected selection(): SelectedFieldsOrdered {
    return orderSelectedFields(this.fields)
  }

  protected override rowsMapper(
    fields: SelectedFieldsOrdered
  ): ((rows: Array<Array<unknown>>) => Array<TResult>) | undefined {
    return joinedRowsMapper(fields, this.nullableObjectPaths)
  }
}
