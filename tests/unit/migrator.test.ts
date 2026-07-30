import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drizzle } from '../../src/index.js';
import { SpannerDdlError } from '../../src/index.js';
import { migrate } from '../../src/migrator.js';
import type { SpannerDriverRow, SpannerSqlRequest } from '../../src/index.js';

const MIGRATION_1 = 'CREATE TABLE `a` (\n  `id` STRING(36) NOT NULL\n) PRIMARY KEY (`id`);\n';
const MIGRATION_2 =
  'ALTER TABLE `a` ADD COLUMN `v` INT64;\n--> statement-breakpoint\n' +
  'CREATE INDEX `idx_a_v` ON `a` (`v`);\n';

async function writeMigrations(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'drizzle-spanner-migrator-'));
  await mkdir(join(out, '20260730100000_init'));
  await writeFile(join(out, '20260730100000_init', 'migration.sql'), MIGRATION_1);
  await mkdir(join(out, '20260730110000_evolve'));
  await writeFile(join(out, '20260730110000_evolve', 'migration.sql'), MIGRATION_2);
  return out;
}

function hashOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

interface FakeOptions {
  bookkeepingExists?: boolean;
  appliedHashes?: string[];
  failDdlAtStatement?: number;
}

function fakeDdlDatabase(options: FakeOptions = {}) {
  const ddlBatches: string[][] = [];
  const dmlStatements: string[] = [];
  const database = {
    async run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[]]> {
      if (request.sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [
          options.bookkeepingExists
            ? [[{ name: 'TABLE_NAME', value: '__drizzle_migrations' }] as SpannerDriverRow]
            : [],
        ];
      }
      if (request.sql.includes('SELECT `hash`')) {
        return [
          (options.appliedHashes ?? []).map(
            (hash) => [{ name: 'hash', value: hash }] as SpannerDriverRow,
          ),
        ];
      }
      throw new Error(`unexpected read: ${request.sql}`);
    },
    async runTransactionAsync<T>(
      runFn: (tx: {
        run(request: SpannerSqlRequest): Promise<[SpannerDriverRow[]]>;
        commit(): Promise<void>;
        rollback(): Promise<void>;
        insert(): void;
        update(): void;
        upsert(): void;
        deleteRows(): void;
      }) => Promise<T>,
    ): Promise<T> {
      return runFn({
        async run(request: SpannerSqlRequest) {
          dmlStatements.push(request.sql);
          return [[]];
        },
        async commit() {},
        async rollback() {},
        insert() {},
        update() {},
        upsert() {},
        deleteRows() {},
      });
    },
    async getSnapshot(): Promise<never> {
      throw new Error('not used');
    },
    async updateSchema(statements: string[]) {
      ddlBatches.push(statements);
      return [
        {
          async promise() {
            if (options.failDdlAtStatement !== undefined) {
              const error = Object.assign(new Error('DDL statement failed'), {
                code: 9,
                metadata: {
                  commitTimestamps: new Array(options.failDdlAtStatement).fill('ts'),
                },
              });
              throw error;
            }
            return undefined;
          },
        },
      ];
    },
  };
  return { database, ddlBatches, dmlStatements };
}

describe('migrate (runtime)', () => {
  it('creates the bookkeeping table, applies each migration as one batch and records it', async () => {
    const out = await writeMigrations();
    const fake = fakeDdlDatabase();
    const db = drizzle(fake.database as never);
    const result = await migrate(db, { migrationsFolder: out });

    expect(fake.ddlBatches[0]?.[0]).toContain('CREATE TABLE `__drizzle_migrations`');
    expect(fake.ddlBatches[1]).toEqual([
      'CREATE TABLE `a` (\n  `id` STRING(36) NOT NULL\n) PRIMARY KEY (`id`)',
    ]);
    expect(fake.ddlBatches[2]).toEqual([
      'ALTER TABLE `a` ADD COLUMN `v` INT64',
      'CREATE INDEX `idx_a_v` ON `a` (`v`)',
    ]);
    expect(fake.dmlStatements).toHaveLength(2);
    expect(fake.dmlStatements[0]).toContain('INSERT INTO `__drizzle_migrations`');
    expect(fake.dmlStatements[0]).toContain(hashOf(MIGRATION_1));
    expect(result.applied).toEqual(['20260730100000_init', '20260730110000_evolve']);
  });

  it('skips already-applied migrations by hash', async () => {
    const out = await writeMigrations();
    const fake = fakeDdlDatabase({
      bookkeepingExists: true,
      appliedHashes: [hashOf(MIGRATION_1)],
    });
    const db = drizzle(fake.database as never);
    const result = await migrate(db, { migrationsFolder: out });
    expect(fake.ddlBatches).toHaveLength(1);
    expect(fake.ddlBatches[0]?.[0]).toContain('ALTER TABLE `a` ADD COLUMN `v` INT64');
    expect(result.applied).toEqual(['20260730110000_evolve']);
  });

  it('applies nothing when every migration is recorded', async () => {
    const out = await writeMigrations();
    const fake = fakeDdlDatabase({
      bookkeepingExists: true,
      appliedHashes: [hashOf(MIGRATION_1), hashOf(MIGRATION_2)],
    });
    const db = drizzle(fake.database as never);
    const result = await migrate(db, { migrationsFolder: out });
    expect(fake.ddlBatches).toHaveLength(0);
    expect(fake.dmlStatements).toHaveLength(0);
    expect(result.applied).toEqual([]);
  });

  it('surfaces a partially failed DDL batch as SpannerDdlError with the statement index', async () => {
    const out = await writeMigrations();
    const fake = fakeDdlDatabase({
      bookkeepingExists: true,
      appliedHashes: [hashOf(MIGRATION_1)],
      failDdlAtStatement: 1,
    });
    const db = drizzle(fake.database as never);
    await expect(migrate(db, { migrationsFolder: out })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SpannerDdlError &&
        error.statementIndex === 1 &&
        /20260730110000_evolve/.test(error.message),
    );
    expect(fake.dmlStatements).toHaveLength(0);
  });
});
