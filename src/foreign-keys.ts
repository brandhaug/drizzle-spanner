import { entityKind } from 'drizzle-orm/entity'
import type { SpannerColumn, SpannerExtraConfigColumn } from './columns/common.js'
import type { SpannerTable } from './table.js'

/** Spanner foreign keys have `ON DELETE` only — `ON UPDATE` actions do not exist. */
export type ForeignKeyAction = 'cascade' | 'noAction'

export interface ForeignKeyConfig {
  name?: string
  /** Referencing columns of the table this entry is declared on. */
  columns: SpannerExtraConfigColumn[]
  /** Referenced columns; all must belong to one table. */
  foreignColumns: SpannerColumn<any>[]
}

export class ForeignKeyBuilder {
  static readonly [entityKind]: string = 'SpannerForeignKeyBuilder'

  /** @internal */
  readonly config: {
    name: string | undefined
    columns: SpannerExtraConfigColumn[]
    foreignColumns: SpannerColumn<any>[]
    foreignTable: SpannerTable
    onDelete: ForeignKeyAction
  }

  constructor(config: ForeignKeyConfig) {
    const foreignTable = config.foreignColumns[0]?.table
    if (!foreignTable) {
      throw new Error('foreignKey: foreignColumns must name at least one column')
    }
    if (config.foreignColumns.some((column) => column.table !== foreignTable)) {
      throw new Error('foreignKey: foreignColumns must all belong to one table')
    }
    this.config = {
      name: config.name,
      columns: config.columns,
      foreignColumns: config.foreignColumns,
      foreignTable,
      onDelete: 'noAction'
    }
  }

  /** `ON DELETE { CASCADE | NO ACTION }`; `NO ACTION` is Spanner's default. */
  onDelete(action: ForeignKeyAction): this {
    this.config.onDelete = action
    return this
  }
}

/**
 * `CONSTRAINT name FOREIGN KEY (...) REFERENCES t (...)` — an extra-config
 * entry in the third argument of `spannerTable`. Spanner foreign keys have no
 * `ON UPDATE` actions and cannot reference commit-timestamp columns.
 */
export function foreignKey(config: ForeignKeyConfig): ForeignKeyBuilder {
  return new ForeignKeyBuilder(config)
}
