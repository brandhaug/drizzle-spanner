import { entityKind, is } from 'drizzle-orm/entity';
import { SQL } from 'drizzle-orm/sql';
import { SpannerExtraConfigColumn } from './columns/common.js';
import type { SpannerColumn } from './columns/common.js';
import type { SpannerTable } from './table.js';

export class IndexedColumn {
  static readonly [entityKind]: string = 'SpannerIndexedColumn';

  constructor(
    readonly name: string,
    readonly order: 'asc' | 'desc',
  ) {}
}

export interface IndexConfig {
  name: string;
  columns: (IndexedColumn | SQL)[];
  unique: boolean;
  nullFiltered: boolean;
  storing: (SpannerColumn<any> | SpannerExtraConfigColumn)[];
}

export class IndexBuilderOn {
  static readonly [entityKind]: string = 'SpannerIndexBuilderOn';

  constructor(
    private readonly name: string,
    private readonly unique: boolean,
  ) {}

  on(...columns: [SpannerExtraConfigColumn | SQL, ...(SpannerExtraConfigColumn | SQL)[]]): IndexBuilder {
    return new IndexBuilder(
      this.name,
      columns.map((column) => {
        if (is(column, SQL)) return column;
        const indexed = new IndexedColumn(column.name, column.indexConfig.order);
        column.indexConfig = { order: 'asc' };
        return indexed;
      }),
      this.unique,
    );
  }
}

export class IndexBuilder {
  static readonly [entityKind]: string = 'SpannerIndexBuilder';

  /** @internal */
  readonly config: IndexConfig;

  constructor(name: string, columns: (IndexedColumn | SQL)[], unique: boolean) {
    this.config = { name, columns, unique, nullFiltered: false, storing: [] };
  }

  /** `NULL_FILTERED` — excludes rows with a NULL key part. */
  nullFiltered(): this {
    this.config.nullFiltered = true;
    return this;
  }

  /** `STORING (...)` — copies extra columns into the index to avoid base-table joins. */
  storing(
    ...columns: [
      SpannerColumn<any> | SpannerExtraConfigColumn,
      ...(SpannerColumn<any> | SpannerExtraConfigColumn)[],
    ]
  ): this {
    this.config.storing.push(...columns);
    return this;
  }

  /** @internal */
  build(table: SpannerTable): Index {
    return new Index(this.config, table);
  }
}

export class Index {
  static readonly [entityKind]: string = 'SpannerIndex';

  readonly config: IndexConfig & { table: SpannerTable };

  constructor(config: IndexConfig, table: SpannerTable) {
    this.config = { ...config, table };
  }
}

/** `CREATE INDEX name ON ...` with Spanner extensions `.nullFiltered()` and `.storing(...)`. */
export function index(name: string): IndexBuilderOn {
  return new IndexBuilderOn(name, false);
}

/** `CREATE UNIQUE INDEX name ON ...`. */
export function uniqueIndex(name: string): IndexBuilderOn {
  return new IndexBuilderOn(name, true);
}
