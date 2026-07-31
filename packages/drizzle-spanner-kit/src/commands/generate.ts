import type { ResolvedSpannerKitConfig } from '../config.js'
import type { RenameResolver, ResolvedRename } from '../differ.js'
import { diffSnapshots } from '../differ.js'
import { loadSchemaExports } from '../loader.js'
import {
  formatTimestamp,
  readLatestSnapshot,
  writeMigrationFolder
} from '../migrations.js'
import { serializeSchema } from '../serializer.js'
import { createSnapshot } from '../snapshot.js'

export interface GenerateOptions {
  /** Migration name; the folder becomes `<timestamp>_<name>`. */
  name?: string
  /** Interactive rename resolution; omit for non-interactive runs. */
  resolveRename?: RenameResolver
  /** Non-interactive only: allow ambiguous renames to become drop+create. */
  acceptDrops?: boolean
  /** Timestamp override (tests). */
  now?: Date
}

export interface GenerateResult {
  /** The written migration folder, or null when the diff is empty. */
  folder: string | null
  statements: string[]
  renames: ResolvedRename[]
}

/** `generate`: schema module -> snapshot -> diff against the latest snapshot -> migration folder. */
export async function generate(
  config: Pick<ResolvedSpannerKitConfig, 'schema' | 'out'>,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const schemaExports = await loadSchemaExports(config.schema)
  const ddl = serializeSchema(schemaExports)
  const prevSnapshot = await readLatestSnapshot(config.out)
  const { statements, renames } = await diffSnapshots(prevSnapshot?.ddl ?? [], ddl, {
    resolveRename: options.resolveRename,
    acceptDrops: options.acceptDrops
  })
  if (statements.length === 0) {
    return { folder: null, statements, renames }
  }
  const snapshot = createSnapshot(ddl, {
    prevIds: prevSnapshot ? [prevSnapshot.id] : [],
    // The v8 snapshot format records renames as `old->new` journal strings.
    renames: renames.map(({ from, to }) => `${from}->${to}`)
  })
  const folder = await writeMigrationFolder(
    config.out,
    formatTimestamp(options.now ?? new Date()),
    options.name ?? 'migration',
    statements,
    snapshot
  )
  return { folder, statements, renames }
}
