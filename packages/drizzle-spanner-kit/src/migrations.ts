import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { type SpannerSnapshot } from './snapshot.js'
import { parseSnapshot } from './snapshot.js'

/** `<out>/<YYYYMMDDHHMMSS>_<name>/` with migration.sql + snapshot.json. */
interface MigrationFolder {
  folder: string
  /** Folder basename, `20260730100000_init`. */
  id: string
  timestamp: string
  name: string
}

const FOLDER_PATTERN = /^(\d{14})_(.+)$/
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** Migration folders under `out`, sorted by timestamp (folder name). */
async function listMigrationFolders(out: string): Promise<Array<MigrationFolder>> {
  let entries
  try {
    entries = await readdir(out, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, match: FOLDER_PATTERN.exec(entry.name) }))
    .filter((candidate) => candidate.match !== null)
    .map(({ entry, match }) => ({
      folder: join(out, entry.name),
      id: entry.name,
      timestamp: match![1]!,
      name: match![2]!
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

async function readSnapshot(migration: MigrationFolder): Promise<SpannerSnapshot> {
  const path = join(migration.folder, 'snapshot.json')
  return parseSnapshot(await readFile(path, 'utf8'), path)
}

/** The latest snapshot in the migrations folder, or null before the first migration. */
export async function readLatestSnapshot(out: string): Promise<SpannerSnapshot | null> {
  const folders = await listMigrationFolders(out)
  const latest = folders.at(-1)
  return latest ? readSnapshot(latest) : null
}

// Hoisted to module scope: used only by formatTimestamp, but a per-call
// arrow would trip consistent-function-scoping.
const pad2 = (value: number): string => String(value).padStart(2, '0')

export function formatTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`
  )
}

function renderMigrationSql(statements: Array<string>): string {
  return statements
    .map((statement) => `${statement};\n`)
    .join(`${STATEMENT_BREAKPOINT}\n`)
}

export async function writeMigrationFolder(
  out: string,
  timestamp: string,
  name: string,
  statements: Array<string>,
  snapshot: SpannerSnapshot
): Promise<string> {
  const id = `${timestamp}_${name}`
  if (!/^\d{14}$/.test(timestamp) || !name || /[/\\\r\n\u2028\u2029]/.test(name)) {
    throw new Error('drizzle-spanner-kit: invalid migration timestamp or name')
  }
  const folder = join(out, id)
  // Reserve the name across concurrent writers. Hidden staging/lock directories
  // are never included by listMigrationFolders.
  await mkdir(out, { recursive: true })
  const reservation = join(out, `.${id}.lock`)
  await mkdir(reservation)
  let staging: string | undefined
  try {
    const existing = await lstat(folder).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (existing) {
      throw new Error(`drizzle-spanner-kit: migration "${id}" already exists`)
    }
    const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`
    staging = await mkdtemp(join(out, '.migration-'))
    await writeFile(join(staging, 'migration.sql'), renderMigrationSql(statements))
    await writeFile(join(staging, 'snapshot.json'), snapshotJson)
    await rename(staging, folder)
    return folder
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true })
    }
    await rm(reservation, { recursive: true, force: true })
  }
}
