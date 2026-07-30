import type { SpannerKitDatabaseConfig } from './config.js';

/** Structural view of the driver pieces the kit's commands use. */
export interface KitDriverDatabase {
  run(request: {
    sql: string;
    params?: Record<string, unknown>;
    types?: Record<string, unknown>;
  }): Promise<[unknown[], ...unknown[]]>;
  updateSchema(statements: string[]): Promise<[{ promise(): Promise<unknown> }, ...unknown[]]>;
  close(): Promise<unknown>;
}

export interface KitConnection {
  database: KitDriverDatabase;
  close(): Promise<void>;
}

/**
 * Opens the driver `Database` named by the config. `@google-cloud/spanner`
 * is an optional peer, imported lazily so `generate` runs without it.
 */
export async function connectDatabase(config: SpannerKitDatabaseConfig): Promise<KitConnection> {
  if (config.emulatorHost) {
    process.env.SPANNER_EMULATOR_HOST = config.emulatorHost;
  }
  let spannerModule: typeof import('@google-cloud/spanner');
  try {
    spannerModule = await import('@google-cloud/spanner');
  } catch (error) {
    throw new Error(
      'drizzle-spanner-kit: @google-cloud/spanner is required for migrate, pull and push (npm install @google-cloud/spanner)',
      { cause: error },
    );
  }
  const spanner = new spannerModule.Spanner({ projectId: config.project });
  const database = spanner
    .instance(config.instance)
    .database(config.database) as unknown as KitDriverDatabase;
  return {
    database,
    async close() {
      await database.close();
      spanner.close();
    },
  };
}
