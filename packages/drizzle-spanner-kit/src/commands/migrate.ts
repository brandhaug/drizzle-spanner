import type { SpannerDriverDatabase } from 'drizzle-spanner';
import { drizzle } from 'drizzle-spanner';
import type { SpannerMigrationResult } from 'drizzle-spanner/migrator';
import { migrate as migrateDatabase } from 'drizzle-spanner/migrator';
import type { ResolvedSpannerKitConfig } from '../config.js';
import { requireDatabase } from '../config.js';
import { connectDatabase } from '../connect.js';

/**
 * `migrate`: applies pending migration folders from the out dir through the
 * runtime migrator — one batched `updateSchema` operation per migration,
 * recorded in `drizzle_migrations`, idempotent by hash.
 */
export async function migrate(
  config: Pick<ResolvedSpannerKitConfig, 'out' | 'database'>,
): Promise<SpannerMigrationResult> {
  const databaseConfig = requireDatabase(config, 'migrate');
  const connection = await connectDatabase(databaseConfig);
  try {
    const db = drizzle(connection.database as unknown as SpannerDriverDatabase);
    return await migrateDatabase(db, { migrationsFolder: config.out });
  } finally {
    await connection.close();
  }
}
