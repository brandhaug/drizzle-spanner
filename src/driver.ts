import type { AnyRelations } from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { Logger } from 'drizzle-orm/logger';
import { DefaultLogger } from 'drizzle-orm/logger';
import type { SpannerDriverDatabase } from './db.js';
import { createDatabaseSession, createMockSession, SpannerDatabase } from './db.js';
import { SpannerDialect } from './dialect.js';

export type SpannerDrizzleConfig<TRelations extends AnyRelations = AnyRelations> = Pick<
  DrizzleConfig<Record<string, unknown>, TRelations>,
  'logger' | 'casing' | 'relations' | 'cache'
>;

function resolveLogger(logger: SpannerDrizzleConfig['logger']): Logger | undefined {
  if (logger === true) return new DefaultLogger();
  if (logger === false || logger === undefined) return undefined;
  return logger;
}

/**
 * Entry point: takes a constructed `@google-cloud/spanner` `Database`
 * (session-pool configuration belongs to the client) and drizzle config.
 * `relations` and `cache` are carried for the milestone-2 consumers.
 */
export function drizzle(
  client: SpannerDriverDatabase,
  config: SpannerDrizzleConfig = {},
): SpannerDatabase {
  const dialect = new SpannerDialect({ casing: config.casing });
  const session = createDatabaseSession(client, dialect, {
    logger: resolveLogger(config.logger),
  });
  return new SpannerDatabase(dialect, session, client, {
    relations: config.relations,
    cache: config.cache,
  });
}

/** A database with no client attached — SQL generation only; execution throws. */
drizzle.mock = (config: SpannerDrizzleConfig = {}): SpannerDatabase => {
  const dialect = new SpannerDialect({ casing: config.casing });
  return new SpannerDatabase(dialect, createMockSession(dialect), undefined, {
    relations: config.relations,
    cache: config.cache,
  });
};
