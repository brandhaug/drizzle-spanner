import { randomUUID } from 'node:crypto'
import type { Database } from '@google-cloud/spanner'
import { drizzle } from '../../src/index.js'
import type { SpannerDatabase, SpannerDriverDatabase } from '../../src/index.js'
import { startSpannerTestTarget } from './spanner-target.js'

export interface EmulatorHarness {
  db: SpannerDatabase
  database: Database
  cleanup(): Promise<void>
}

/**
 * One Spanner test target per test file (see `startSpannerTestTarget`); each
 * file gets its own randomly named database.
 */
export async function startEmulator(ddl: string[]): Promise<EmulatorHarness> {
  const target = await startSpannerTestTarget('test-instance')

  const [database, databaseOperation] = await target.instance.createDatabase(
    `test-db-${randomUUID().slice(0, 8)}`
  )
  await databaseOperation.promise()

  if (ddl.length > 0) {
    const [ddlOperation] = await database.updateSchema(ddl)
    await ddlOperation.promise()
  }

  return {
    db: drizzle(database as SpannerDriverDatabase),
    database,
    async cleanup() {
      // A real instance outlives the run; drop the database instead of
      // leaving it behind. Emulator state dies with the container.
      if (target.emulatorHost) await database.close()
      else await database.delete()
      await target.stop()
    }
  }
}
