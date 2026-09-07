import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renderSchemaModule } from '../codegen.js'
import { type ResolvedSpannerKitConfig } from '../config.js'
import { requireDatabase } from '../config.js'
import { connectDatabase } from '../connect.js'
import { diffSnapshots } from '../differ.js'
import { introspectDatabase } from '../introspect.js'
import { loadSchemaExports } from '../loader.js'
import { formatTimestamp, writeMigrationFolder } from '../migrations.js'
import { serializeSchema } from '../serializer.js'
import { assertSchemaRoundtrip } from '../schema-roundtrip.js'
import { createSnapshot } from '../snapshot.js'

export interface PullOptions {
  /** Where the emitted schema module goes; defaults to `<out>/schema.ts`. */
  schemaFile?: string
  /** Migration folder name; defaults to `pull`. */
  name?: string
  /** Timestamp override (tests). */
  now?: Date
}

export interface PullResult {
  schemaFile: string
  /** The written baseline migration folder. */
  folder: string
  tables: number
}

/**
 * `pull`: introspects INFORMATION_SCHEMA, emits a schema module in the
 * schema API, verifies it against introspection, then publishes the schema
 * and a baseline migration snapshot of the introspected database.
 */
export async function pull(
  config: Pick<ResolvedSpannerKitConfig, 'out' | 'database'>,
  options: PullOptions = {}
): Promise<PullResult> {
  const databaseConfig = requireDatabase(config, 'pull')
  const connection = await connectDatabase(databaseConfig)
  let introspected
  try {
    introspected = await introspectDatabase(connection.database)
  } finally {
    await connection.close()
  }

  const schemaFile = options.schemaFile ?? join(config.out, 'schema.ts')
  await mkdir(dirname(schemaFile), { recursive: true })
  // Stage beside the destination so module resolution uses the same project.
  const stagedSchema = join(dirname(schemaFile), `.pull-${randomUUID()}.ts`)
  try {
    await writeFile(stagedSchema, renderSchemaModule(introspected), { flag: 'wx' })
    const schemaExports = await loadSchemaExports([stagedSchema])
    assertSchemaRoundtrip(introspected, serializeSchema(schemaExports))
    await rename(stagedSchema, schemaFile)
  } finally {
    await rm(stagedSchema, { force: true })
  }
  const { statements } = await diffSnapshots([], introspected)
  const folder = await writeMigrationFolder(
    config.out,
    formatTimestamp(options.now ?? new Date()),
    options.name ?? 'pull',
    statements,
    createSnapshot(introspected)
  )
  return {
    schemaFile,
    folder,
    tables: introspected.filter((entity) => entity.entityType === 'tables').length
  }
}
