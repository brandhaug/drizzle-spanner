import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpannerSnapshot } from './snapshot.js';
import { parseSnapshot } from './snapshot.js';

/** `<out>/<YYYYMMDDHHMMSS>_<name>/` with migration.sql + snapshot.json. */
export interface MigrationFolder {
  folder: string;
  /** Folder basename, `20260730100000_init`. */
  id: string;
  timestamp: string;
  name: string;
}

const FOLDER_PATTERN = /^(\d{14})_(.+)$/;
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** Migration folders under `out`, sorted by timestamp (folder name). */
export async function listMigrationFolders(out: string): Promise<MigrationFolder[]> {
  let entries;
  try {
    entries = await readdir(out, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, match: FOLDER_PATTERN.exec(entry.name) }))
    .filter((candidate) => candidate.match !== null)
    .map(({ entry, match }) => ({
      folder: join(out, entry.name),
      id: entry.name,
      timestamp: match![1]!,
      name: match![2]!,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function readMigrationSql(migration: MigrationFolder): Promise<string> {
  return readFile(join(migration.folder, 'migration.sql'), 'utf8');
}

/** Splits migration.sql into statements on the breakpoint marker. */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim().replace(/;$/, ''))
    .filter((statement) => statement.length > 0);
}

export async function readSnapshot(migration: MigrationFolder): Promise<SpannerSnapshot> {
  const path = join(migration.folder, 'snapshot.json');
  return parseSnapshot(await readFile(path, 'utf8'), path);
}

/** The latest snapshot in the migrations folder, or null before the first migration. */
export async function readLatestSnapshot(out: string): Promise<SpannerSnapshot | null> {
  const folders = await listMigrationFolders(out);
  const latest = folders[folders.length - 1];
  return latest ? readSnapshot(latest) : null;
}

export function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function renderMigrationSql(statements: string[]): string {
  return statements.map((statement) => `${statement};\n`).join(`${STATEMENT_BREAKPOINT}\n`);
}

export async function writeMigrationFolder(
  out: string,
  timestamp: string,
  name: string,
  statements: string[],
  snapshot: SpannerSnapshot,
): Promise<string> {
  const folder = join(out, `${timestamp}_${name}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'migration.sql'), renderMigrationSql(statements));
  await writeFile(join(folder, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  return folder;
}
