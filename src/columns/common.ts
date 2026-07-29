import type {
  ColumnBuilderBase,
  ColumnBuilderBaseConfig,
  ColumnBuilderRuntimeConfig,
  ColumnType,
  GeneratedColumnConfig,
  HasGenerated,
  MakeColumnConfig,
} from 'drizzle-orm/column-builder';
import { ColumnBuilder } from 'drizzle-orm/column-builder';
import type { ColumnBaseConfig } from 'drizzle-orm/column';
import { Column } from 'drizzle-orm/column';
import { entityKind } from 'drizzle-orm/entity';
import type { SQL } from 'drizzle-orm/sql';
import type { Table } from 'drizzle-orm/table';
import type { SpannerTable } from '../table.js';

/**
 * Local replacements for drizzle-orm's `BuildColumn`/`BuildColumns` helpers.
 * The upstream `Dialect` type union is closed, so those helpers cannot map
 * builders onto Spanner column classes (dialect-internals research, blocker 1).
 */
export type BuildSpannerColumn<
  TTableName extends string,
  TBuilder extends ColumnBuilderBase,
> = SpannerColumn<MakeColumnConfig<TBuilder['_'], TTableName>>;

export type BuildSpannerColumns<
  TTableName extends string,
  TConfigMap extends Record<string, ColumnBuilderBase>,
> = { [Key in keyof TConfigMap]: BuildSpannerColumn<TTableName, TConfigMap[Key]> } & {};

export type BuildSpannerExtraConfigColumns<
  TConfigMap extends Record<string, ColumnBuilderBase>,
> = { [Key in keyof TConfigMap]: SpannerExtraConfigColumn } & {};

export abstract class SpannerColumnBuilder<
  T extends ColumnBuilderBaseConfig<ColumnType> = ColumnBuilderBaseConfig<ColumnType>,
  TRuntimeConfig extends object = object,
> extends ColumnBuilder<T> {
  static readonly [entityKind]: string = 'SpannerColumnBuilder';

  // `config` and `setName` exist at runtime on the base ColumnBuilder but are
  // stripped from the published .d.ts as @internal; re-declare them here.
  declare config: ColumnBuilderRuntimeConfig<T['data']> & TRuntimeConfig;
  declare setName: (name: string) => void;

  generatedAlwaysAs(
    as: SQL | T['data'] | (() => SQL),
    config?: Partial<GeneratedColumnConfig<unknown>>,
  ): HasGenerated<this, { type: 'always' }> {
    this.config.generated = {
      as,
      type: 'always',
      mode: config?.mode ?? 'stored',
    } as GeneratedColumnConfig<T['data']>;
    return this as HasGenerated<this, { type: 'always' }>;
  }

  /** Wraps the column in `ARRAY<T>`. Spanner arrays cannot nest. */
  array(): SpannerArrayBuilder<{
    dataType: 'array';
    data: (T extends { $type: infer U } ? U : T['data'])[];
    driverParam: T['driverParam'][];
    notNull: false;
    hasDefault: false;
  }> {
    return new SpannerArrayBuilder(this.config.name, this as unknown as SpannerColumnBuilder) as any;
  }

  /** @internal */
  abstract build(table: SpannerTable): SpannerColumn<any>;

  /** @internal */
  buildExtraConfigColumn(table: SpannerTable): SpannerExtraConfigColumn {
    return new SpannerExtraConfigColumn(table, this.config as ColumnBuilderRuntimeConfig<unknown>);
  }
}

export abstract class SpannerColumn<
  T extends ColumnBaseConfig<ColumnType> = ColumnBaseConfig<ColumnType>,
  TRuntimeConfig extends object = object,
> extends Column<T, TRuntimeConfig> {
  static readonly [entityKind]: string = 'SpannerColumn';

  // Same @internal situation as the builder's `config`.
  declare protected config: ColumnBuilderRuntimeConfig<T['data']> & TRuntimeConfig;

  /** @internal */
  readonly table: SpannerTable;

  constructor(table: SpannerTable, config: ColumnBuilderRuntimeConfig<T['data']> & TRuntimeConfig) {
    super(table as unknown as Table, config);
    this.table = table;
  }
}

/**
 * Column facade handed to the extra-config callback of `spannerTable` so
 * `index().on(...)` and `primaryKey()` can capture key parts with sort order.
 */
export class SpannerExtraConfigColumn extends Column {
  static override readonly [entityKind]: string = 'SpannerExtraConfigColumn';

  indexConfig: { order: 'asc' | 'desc' } = { order: 'asc' };

  constructor(table: SpannerTable, config: ColumnBuilderRuntimeConfig<unknown>) {
    super(table as unknown as Table, config);
  }

  getSQLType(): string {
    return this.columnType;
  }

  asc(): this {
    this.indexConfig.order = 'asc';
    return this;
  }

  desc(): this {
    this.indexConfig.order = 'desc';
    return this;
  }
}

export interface SpannerArrayBuilderConfig extends ColumnBuilderBaseConfig<'array'> {
  data: unknown[];
  driverParam: unknown[];
}

export class SpannerArrayBuilder<
  T extends Omit<ColumnBuilderBaseConfig<'array'>, 'name'> = SpannerArrayBuilderConfig,
> extends SpannerColumnBuilder<
  T & ColumnBuilderBaseConfig<'array'>,
  { baseBuilder: SpannerColumnBuilder }
> {
  static override readonly [entityKind]: string = 'SpannerArrayBuilder';

  constructor(name: string, baseBuilder: SpannerColumnBuilder) {
    super(name, 'array', 'SpannerArray');
    this.config.baseBuilder = baseBuilder;
  }

  /** @internal */
  build(table: SpannerTable): SpannerArray {
    const baseColumn = this.config.baseBuilder.build(table);
    return new SpannerArray(
      table,
      this.config as ColumnBuilderRuntimeConfig<unknown[]>,
      baseColumn,
    );
  }
}

export class SpannerArray extends SpannerColumn<ColumnBaseConfig<'array'>> {
  static override readonly [entityKind]: string = 'SpannerArray';

  readonly baseColumn: SpannerColumn<any>;

  constructor(
    table: SpannerTable,
    config: ColumnBuilderRuntimeConfig<unknown[]>,
    baseColumn: SpannerColumn<any>,
  ) {
    super(table, config as any);
    this.baseColumn = baseColumn;
  }

  getSQLType(): string {
    return `ARRAY<${this.baseColumn.getSQLType()}>`;
  }

  override mapFromDriverValue(value: unknown): unknown {
    if (value === null) return null;
    return (value as unknown[]).map((element) => this.baseColumn.mapFromDriverValue(element));
  }

  override mapToDriverValue(value: unknown): unknown {
    if (value === null) return null;
    return (value as unknown[]).map((element) =>
      element === null ? null : this.baseColumn.mapToDriverValue(element),
    );
  }
}
