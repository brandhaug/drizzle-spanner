import { is } from 'drizzle-orm/entity'
import {
  type BuildQueryConfig,
  type DriverValueEncoder,
  type Query,
  type SQLChunk,
  Param,
  SQL
} from 'drizzle-orm/sql'
import { SpannerColumn } from './columns/common.js'
import { type SpannerQueryWithTypings } from './dialect.js'

/**
 * Drizzle rc.4 removed Query.typings. Observe its recursive compiler at the
 * escapeParam boundary instead of independently interpreting the SQL tree.
 * Each recursive call replaces the observer with the current chunk's encoder,
 * so wrappers and encoder-produced SQL use their own emitted parameters.
 * Keep this compatibility adapter covered when updating drizzle-orm.
 */
class SQLWithParamMetadata extends SQL {
  readonly typings: Array<string> = []
  readonly paramColumns: Array<string | undefined> = []

  constructor(
    input: SQL,
    private readonly escapeParameter: BuildQueryConfig['escapeParam'],
    private readonly prepareTyping: (
      encoder: DriverValueEncoder<unknown, unknown>
    ) => string
  ) {
    super([input])
  }

  override buildQueryFromSourceParams(
    chunks: Array<SQLChunk>,
    config: BuildQueryConfig
  ): Query {
    const paramStartIndex = config.paramStartIndex ?? { value: 0 }
    const result: Query = { sql: '', params: [] }
    for (const chunk of chunks) {
      const query = super.buildQueryFromSourceParams([chunk], {
        ...config,
        paramStartIndex,
        escapeParam: (index, value) => {
          const encoder = is(chunk, Param) ? chunk.encoder : undefined
          this.typings[index] = encoder ? this.prepareTyping(encoder) : 'none'
          this.paramColumns[index] = is(encoder, SpannerColumn)
            ? encoder.name
            : undefined
          return this.escapeParameter(index, value)
        }
      })
      result.sql += query.sql
      result.params.push(...query.params)
    }
    return result
  }
}

export function compileWithParamMetadata(
  input: SQL,
  config: Pick<
    BuildQueryConfig,
    'escapeName' | 'escapeParam' | 'escapeString' | 'invokeSource'
  >,
  prepareTyping: (encoder: DriverValueEncoder<unknown, unknown>) => string
): SpannerQueryWithTypings {
  const compiler = new SQLWithParamMetadata(input, config.escapeParam, prepareTyping)
  const query = compiler.toQuery(config)
  return { ...query, typings: compiler.typings, paramColumns: compiler.paramColumns }
}
