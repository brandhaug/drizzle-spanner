import { entityKind } from 'drizzle-orm/entity'
import { type SQL } from 'drizzle-orm/sql'
import { sql } from 'drizzle-orm/sql'

/**
 * A named Spanner sequence (bit-reversed positive, the only kind Spanner
 * offers). `nextValue()` is usable as a column `.default()` and as a
 * write-site value in `values()` / `set()`. DDL creation belongs to
 * drizzle-spanner-kit.
 */
export class SpannerSequence {
  static readonly [entityKind]: string = 'SpannerSequence'

  constructor(readonly name: string) {}

  /** `GET_NEXT_SEQUENCE_VALUE(SEQUENCE name)`. */
  nextValue(): SQL<bigint> {
    return sql`GET_NEXT_SEQUENCE_VALUE(SEQUENCE ${sql.identifier(this.name)})`
  }
}

/** Declares a Spanner sequence by name for use with `.default(seq.nextValue())`. */
export function sequence(name: string): SpannerSequence {
  return new SpannerSequence(name)
}
