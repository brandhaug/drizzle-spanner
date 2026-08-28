/**
 * Spanner parameter type hints, carried through drizzle's `typings` channel.
 * The upstream `QueryTypingsValue` union is closed at the type level but
 * unvalidated at runtime (spike finding), so these strings ride through it;
 * this module is the one place that encodes and decodes them.
 */

export type SpannerScalarTypeHint =
  | 'int64'
  | 'float64'
  | 'float32'
  | 'numeric'
  | 'string'
  | 'bytes'
  | 'bool'
  | 'date'
  | 'timestamp'
  | 'json'
  | 'none'

export type SpannerTypeHint = SpannerScalarTypeHint | `array:${SpannerScalarTypeHint}`

/** Spanner arrays cannot nest, so the element hint is always scalar. */
export function arrayTypeHint(element: SpannerTypeHint): SpannerTypeHint {
  return `array:${element}` as SpannerTypeHint
}

/** The `types` entry shape `@google-cloud/spanner` accepts per parameter. */
export type SpannerDriverParamType = string | { type: 'array'; child: string }

/** Decodes a hint into a driver `types` entry; `none` yields no entry. */
export function toDriverParamType(hint: string): SpannerDriverParamType | undefined {
  if (hint === 'none') {
    return undefined
  }
  return hint.startsWith('array:')
    ? { type: 'array', child: hint.slice('array:'.length) }
    : hint
}
