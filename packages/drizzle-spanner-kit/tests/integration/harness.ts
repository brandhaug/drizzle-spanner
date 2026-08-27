import { randomUUID } from 'node:crypto'
import { type Database } from '@google-cloud/spanner'
import { type SpannerKitDatabaseConfig } from '../../src/index.js'
import { startSpannerTestTarget } from '../../../../tests/integration/spanner-target.js'

export interface KitEmulatorHarness {
  host: string | undefined
  project: string
  instanceName: string
  /** Creates a database on the target and returns the kit config for it. */
  createDatabase(
    name: string
  ): Promise<{ config: SpannerKitDatabaseConfig; database: Database }>
  cleanup(): Promise<void>
}

/** One Spanner test target per test file, exposing connection coordinates for the kit. */
export async function startKitEmulator(): Promise<KitEmulatorHarness> {
  const target = await startSpannerTestTarget('kit-instance')
  const suffix = randomUUID().slice(0, 8)

  const databases: Database[] = []
  return {
    host: target.emulatorHost,
    project: target.project,
    instanceName: target.instanceName,
    async createDatabase(name: string) {
      const [database, databaseOperation] = await target.instance.createDatabase(
        `${name}-${suffix}`
      )
      await databaseOperation.promise()
      databases.push(database)
      return {
        config: {
          project: target.project,
          instance: target.instanceName,
          database: `${name}-${suffix}`,
          emulatorHost: target.emulatorHost
        },
        database
      }
    },
    async cleanup() {
      for (const database of databases) {
        // A real instance outlives the run; drop created databases there.
        if (target.emulatorHost) await database.close()
        else await database.delete()
      }
      await target.stop()
    }
  }
}
