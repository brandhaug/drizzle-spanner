import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renderSchemaModule } from '../codegen.js'
import type { ResolvedSpannerKitConfig } from '../config.js'
import { requireDatabase } from '../config.js'
import { connectDatabase } from '../connect.js'
import { diffSnapshots } from '../differ.js'
import { introspectDatabase } from '../introspect.js'
import { loadSchemaExports } from '../loader.js'
import { formatTimestamp, writeMigrationFolder } from '../migrations.js'
import { serializeSchema } from '../serializer.js'
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
 * schema API, and writes a baseline migration folder whose snapshot comes
 * from serializing the emitted module — so the next `generate` against it
 * diffs empty.
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
  await writeFile(schemaFile, renderSchemaModule(introspected))

  // Serializing the emitted module (not the raw introspection) guarantees
  // the snapshot and the schema file agree, so `generate` sees no diff.
  const schemaExports = await loadSchemaExports([schemaFile])
  const ddl = serializeSchema(schemaExports)
  const { statements } = await diffSnapshots([], ddl)
  const folder = await writeMigrationFolder(
    config.out,
    formatTimestamp(options.now ?? new Date()),
    options.name ?? 'pull',
    statements,
    createSnapshot(ddl)
  )
  return {
    schemaFile,
    folder,
    tables: ddl.filter((entity) => entity.entityType === 'tables').length
  }
}
