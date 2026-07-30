import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder';
import type { ColumnBaseConfig } from 'drizzle-orm/column';
import { entityKind } from 'drizzle-orm/entity';
import type { SpannerTable } from '../table.js';
import type { SpannerTypeHint } from '../type-hints.js';
import { SpannerColumn, SpannerColumnBuilder } from './common.js';
import { unwrapFloat } from './float64.js';

export interface SpannerFloat32BuilderConfig extends ColumnBuilderBaseConfig<'number float'> {
  data: number;
  driverParam: number;
}

export class SpannerFloat32Builder extends SpannerColumnBuilder<SpannerFloat32BuilderConfig> {
  static override readonly [entityKind]: string = 'SpannerFloat32Builder';

  constructor(name: string) {
    super(name, 'number float', 'SpannerFloat32');
  }

  /** @internal */
  build(table: SpannerTable): SpannerFloat32 {
    return new SpannerFloat32(table, this.config);
  }
}

export class SpannerFloat32 extends SpannerColumn<ColumnBaseConfig<'number float'>> {
  static override readonly [entityKind]: string = 'SpannerFloat32';

  getSQLType(): string {
    return 'FLOAT32';
  }

  typeHint(): SpannerTypeHint {
    return 'float32';
  }

  override mapFromDriverValue(value: unknown): number | null {
    if (value === null) return null;
    return unwrapFloat(value);
  }
}

/** `FLOAT32` — single precision; not allowed in a primary key. */
export function float32(name: string): SpannerFloat32Builder {
  return new SpannerFloat32Builder(name);
}
