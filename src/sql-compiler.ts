import { is } from 'drizzle-orm/entity'
import {
  type BuildQueryConfig,
  type DriverValueEncoder,
  Param,
  SQL
} from 'drizzle-orm/sql'
import { SpannerColumn } from './columns/common.js'
import { type SpannerQueryWithTypings } from './dialect.js'
import { SpannerArrayParamEncoder } from './expressions.js'

type CollectBoundValue = (
  this: SQL,
  value: unknown,
  encoder: DriverValueEncoder<unknown, unknown>,
  ...rest: Array<unknown>
) => void

/**
 * drizzle-orm's private per-value hook: `collectSQL` calls it on the root SQL
 * with the encoder of every bound parameter right before `escapeParam`. It is
 * not part of the published types; `tests/unit/sql-compiler.test.ts` guards it
 * across drizzle-orm updates.
 */
const collectBoundValue = (
  SQL.prototype as unknown as { collectBoundValue?: CollectBoundValue }
).collectBoundValue

/** The schema column a parameter binds through, for error hints. */
function paramColumnName(
  encoder: DriverValueEncoder<unknown, unknown> | undefined
): string | undefined {
  if (is(encoder, SpannerColumn)) {
    return encoder.name
  }
  if (is(encoder, SpannerArrayParamEncoder)) {
    return encoder.column.name
  }
  return undefined
}

/**
 * Drizzle's Query carries no parameter typings. Observe its compiler at the
 * escapeParam boundary instead of independently interpreting the SQL tree:
 * the encoder of the value being bound is tracked on a stack, so encoders that
 * map to SQL with their own parameters report those parameters' encoders.
 */
export function compileWithParamMetadata(
  input: SQL,
  config: Pick<
    BuildQueryConfig,
    'escapeName' | 'escapeParam' | 'escapeString' | 'invokeSource'
  >,
  prepareTyping: (encoder: DriverValueEncoder<unknown, unknown>) => string
): SpannerQueryWithTypings {
  if (typeof collectBoundValue !== 'function') {
    throw new TypeError(
      'drizzle-spanner: this drizzle-orm version has no SQL.collectBoundValue; parameter type hints cannot be collected'
    )
  }
  const typings: Array<string> = []
  const paramColumns: Array<string | undefined> = []
  const encoders: Array<DriverValueEncoder<unknown, unknown>> = []
  const root = new SQL([input])
  // collectSQL recurses on the root, so an own property shadows the prototype hook for this compilation only.
  Object.defineProperty(root, 'collectBoundValue', {
    value(
      this: SQL,
      value: unknown,
      encoder: DriverValueEncoder<unknown, unknown>,
      ...rest: Array<unknown>
    ): void {
      encoders.push(encoder)
      try {
        collectBoundValue.call(this, value, encoder, ...rest)
      } finally {
        encoders.pop()
      }
    }
  })
  const query = root.toQuery({
    ...config,
    escapeParam: (index, value) => {
      // A placeholder reaches escapeParam as its Param chunk, outside collectBoundValue.
      const encoder = is(value, Param) ? value.encoder : encoders.at(-1)
      typings[index] = encoder ? prepareTyping(encoder) : 'none'
      paramColumns[index] = paramColumnName(encoder)
      return config.escapeParam(index, value)
    }
  })
  return { ...query, typings, paramColumns }
}
