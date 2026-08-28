import { type SpannerDriverDatabase, type SpannerSqlRequest } from 'drizzle-spanner'
import { type SpannerDriverDatabaseWithDdl } from 'drizzle-spanner/migrator'
import { type SpannerKitDatabaseConfig } from './config.js'

/** The published request shape with `params`/`types` optional — kit reads carry none. */
export type KitSqlRequest = Pick<SpannerSqlRequest, 'sql' | 'json'> &
  Partial<Pick<SpannerSqlRequest, 'params' | 'types'>>

/**
 * Structural view of the driver pieces the kit's commands use, composed from
 * the published runtime types plus a kit-shaped `run` overload and `close`.
 */
export type KitDriverDatabase = SpannerDriverDatabase &
  Pick<SpannerDriverDatabaseWithDdl, 'updateSchema'> & {
    run(request: KitSqlRequest): Promise<[Array<unknown>, ...Array<unknown>]>
    close(): Promise<unknown>
  }

export interface KitConnection {
  database: KitDriverDatabase
  close(): Promise<void>
}

/**
 * Opens the driver `Database` named by the config. `@google-cloud/spanner`
 * is an optional peer, imported lazily so `generate` runs without it.
 */
export async function connectDatabase(
  config: SpannerKitDatabaseConfig
): Promise<KitConnection> {
  if (config.emulatorHost) {
    process.env.SPANNER_EMULATOR_HOST = config.emulatorHost
  }
  let spannerModule: typeof import('@google-cloud/spanner')
  try {
    spannerModule = await import('@google-cloud/spanner')
  } catch (error) {
    throw new Error(
      'drizzle-spanner-kit: @google-cloud/spanner is required for migrate, pull and push (npm install @google-cloud/spanner)',
      { cause: error }
    )
  }
  const spanner = new spannerModule.Spanner({ projectId: config.project })
  const database = spanner
    .instance(config.instance)
    .database(config.database) as KitDriverDatabase
  return {
    database,
    async close() {
      await database.close()
      await spanner.close()
    }
  }
}
