// Spike: drizzle() entrypoint for @google-cloud/spanner.
import { DefaultLogger } from 'drizzle-orm/logger';
import { SpannerDialect } from './dialect.js';
import { createDatabaseSession } from './session.js';
import { SpannerDatabase } from './db.js';

export function drizzle(spannerDatabase, config = {}) {
	const dialect = new SpannerDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) logger = new DefaultLogger();
	else if (config.logger !== false) logger = config.logger;
	const session = createDatabaseSession(spannerDatabase, dialect, { logger });
	return new SpannerDatabase(dialect, session, spannerDatabase);
}
