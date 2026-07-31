import { entityKind } from 'drizzle-orm/entity'
import type { SQL } from 'drizzle-orm/sql'

export class CheckBuilder {
  static readonly [entityKind]: string = 'SpannerCheckBuilder'

  constructor(
    readonly name: string,
    readonly value: SQL
  ) {}
}

/**
 * `CONSTRAINT name CHECK (expression)` — an extra-config entry in the third
 * argument of `spannerTable`. The expression must be deterministic, without
 * subqueries or references to other tables.
 */
export function check(name: string, value: SQL): CheckBuilder {
  return new CheckBuilder(name, value)
}
