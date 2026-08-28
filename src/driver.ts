import { type AnyRelations, type EmptyRelations } from 'drizzle-orm/relations'
import { type DrizzleConfig } from 'drizzle-orm/utils'
import { type Logger } from 'drizzle-orm/logger'
import { DefaultLogger } from 'drizzle-orm/logger'
import { type SpannerDriverDatabase } from './db.js'
import { createDatabaseSession, createMockSession, SpannerDatabase } from './db.js'
import { SpannerDialect } from './dialect.js'

export type SpannerDrizzleConfig<TRelations extends AnyRelations = AnyRelations> = Pick<
  DrizzleConfig<Record<string, unknown>, TRelations>,
  'logger' | 'relations' | 'cache'
>

function resolveLogger(logger: SpannerDrizzleConfig['logger']): Logger | undefined {
  if (logger === true) {
    return new DefaultLogger()
  }
  if (logger === false || logger === undefined) {
    return undefined
  }
  return logger
}

/**
 * Entry point: takes a constructed `@google-cloud/spanner` `Database`
 * (session-pool configuration belongs to the client) and drizzle config.
 * `relations` (from `defineRelations`) powers `db.query`.
 */
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  client: SpannerDriverDatabase,
  config: SpannerDrizzleConfig<TRelations> = {}
): SpannerDatabase<TRelations> {
  const dialect = new SpannerDialect()
  const session = createDatabaseSession(client, dialect, {
    logger: resolveLogger(config.logger)
  })
  return new SpannerDatabase<TRelations>(dialect, session, client, {
    relations: config.relations,
    cache: config.cache
  })
}

/** A database with no client attached — SQL generation only; execution throws. */
drizzle.mock = <TRelations extends AnyRelations = EmptyRelations>(
  config: SpannerDrizzleConfig<TRelations> = {}
): SpannerDatabase<TRelations> => {
  const dialect = new SpannerDialect()
  return new SpannerDatabase<TRelations>(
    dialect,
    createMockSession(dialect),
    undefined,
    {
      relations: config.relations,
      cache: config.cache
    }
  )
}
