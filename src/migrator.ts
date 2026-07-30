import { createHash } from 'node:crypto';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { SpannerDatabase, SpannerDriverDatabase } from './db.js';
import { SpannerDdlError } from './errors.js';
import type { SpannerDriverRow } from './session.js';
import { driverRowToObject } from './session.js';

export interface SpannerMigrationConfig {
  migrationsFolder: string;
  /** Bookkeeping table name; defaults to `__drizzle_migrations`. */
  migrationsTable?: string;
}

export interface SpannerMigrationResult {
  /** Folder names applied by this run, in order. */
  applied: string[];
}

/**
 * The DDL surface of the driver's `Database`. `updateSchema` starts one
 * batched long-running operation for the statement list.
 */
export interface SpannerDriverDatabaseWithDdl extends SpannerDriverDatabase {
  updateSchema(statements: string[]): Promise<[{ promise(): Promise<unknown> }, ...unknown[]]>;
}

function escapeIdentifier(name: string): string {
  return `\`${name}\``;
}

function escapeString(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** readMigrationFiles keeps raw chunk text; updateSchema wants bare statements. */
function toStatements(sqlChunks: string[]): string[] {
  return sqlChunks
    .map((chunk) => chunk.trim().replace(/;$/, ''))
    .filter((chunk) => chunk.length > 0);
}

/**
 * Index of the failed statement in a partially applied `updateSchema`
 * operation: the operation metadata carries one commit timestamp per
 * statement that succeeded.
 */
function failedStatementIndex(error: unknown): number | undefined {
  const metadata = (error as { metadata?: { commitTimestamps?: unknown[] } }).metadata;
  if (Array.isArray(metadata?.commitTimestamps)) return metadata.commitTimestamps.length;
  return undefined;
}

async function runDdl(
  client: SpannerDriverDatabaseWithDdl,
  statements: string[],
  migrationName: string,
): Promise<void> {
  try {
    const [operation] = await client.updateSchema(statements);
    await operation.promise();
  } catch (error) {
    const statementIndex = failedStatementIndex(error);
    const failed =
      statementIndex !== undefined && statements[statementIndex] !== undefined
        ? `; failed statement (index ${statementIndex}): ${statements[statementIndex]}`
        : '';
    throw new SpannerDdlError({
      message: `Migration ${migrationName} failed to apply${failed}`,
      code: (error as { code?: number }).code,
      cause: error,
      statementIndex,
    });
  }
}

async function readColumn(
  client: SpannerDriverDatabaseWithDdl,
  sql: string,
  column: string,
): Promise<string[]> {
  const [rows] = await client.run({ sql, params: {}, types: {} });
  return (rows as SpannerDriverRow[]).map((row) => String(driverRowToObject(row)[column]));
}

async function runDml(client: SpannerDriverDatabaseWithDdl, sql: string): Promise<void> {
  await client.runTransactionAsync(async (transaction) => {
    await transaction.run({ sql, params: {}, types: {} });
    await transaction.commit();
  });
}

/**
 * Applies pending migrations from a drizzle-spanner-kit migrations folder:
 * each migration's statements run through `updateSchema` as one batched
 * long-running DDL operation, and completion is recorded in the bookkeeping
 * table (`STRING(36)` UUID primary key and a sha256 hash column — never an
 * auto-increment pattern; spec: migrations and introspection). Already
 * applied migrations are skipped by hash, so re-running is a no-op.
 */
export async function migrate(
  db: SpannerDatabase<any>,
  config: SpannerMigrationConfig,
): Promise<SpannerMigrationResult> {
  const client = db.$client as SpannerDriverDatabaseWithDdl | undefined;
  if (!client) {
    throw new Error('migrate: the database has no client attached (drizzle.mock cannot migrate)');
  }
  if (typeof client.updateSchema !== 'function') {
    throw new Error('migrate: the attached client has no updateSchema (pass the driver Database)');
  }
  const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';
  const migrations = readMigrationFiles({
    migrationsFolder: config.migrationsFolder,
  } satisfies MigrationConfig);

  const escapedTable = escapeIdentifier(migrationsTable);
  const existing = await readColumn(
    client,
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_NAME = ${escapeString(migrationsTable)}`,
    'TABLE_NAME',
  );
  if (existing.length === 0) {
    await runDdl(
      client,
      [
        `CREATE TABLE ${escapedTable} (\n` +
          '  `id` STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),\n' +
          '  `hash` STRING(64) NOT NULL,\n' +
          '  `name` STRING(MAX),\n' +
          '  `created_at` INT64 NOT NULL\n' +
          ') PRIMARY KEY (`id`)',
      ],
      migrationsTable,
    );
  }

  const appliedHashes = new Set(
    await readColumn(client, `SELECT \`hash\` FROM ${escapedTable}`, 'hash'),
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (appliedHashes.has(migration.hash)) continue;
    await runDdl(client, toStatements(migration.sql), migration.name);
    // Inlined literals: a hash, a folder name and epoch millis — no user data.
    await runDml(
      client,
      `INSERT INTO ${escapedTable} (\`hash\`, \`name\`, \`created_at\`) ` +
        `VALUES (${escapeString(migration.hash)}, ${escapeString(migration.name)}, ${migration.folderMillis})`,
    );
    applied.push(migration.name);
  }
  return { applied };
}

/** Recomputes the sha256 hash the bookkeeping table stores for a migration file. */
export function migrationHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
