import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate, migrate, pull, push } from '../../src/index.js';
import type { KitEmulatorHarness } from './harness.js';
import { startKitEmulator } from './harness.js';

// Fixture modules must live inside the repo so their `drizzle-spanner`
// import resolves under both vitest (alias) and Bun (tsconfig paths).
const TMP_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '.tmp');

const SCHEMA_V1 = `
import { sql } from 'drizzle-orm/sql';
import {
  check,
  index,
  int64,
  interleaveInParent,
  primaryKey,
  spannerTable,
  string,
  timestamp,
} from 'drizzle-spanner';

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).notNull().defaultGenerateUuid().primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true }),
});

export const albums = spannerTable(
  'albums',
  {
    id: string('id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 }),
    plays: int64('plays'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_title').on(t.title).nullFiltered().storing(t.plays),
    check('positive_plays', sql\`plays >= 0\`),
  ],
);
`;

const SCHEMA_V2 = `${SCHEMA_V1}
export const venues = spannerTable('venues', {
  id: string('id', { length: 36 }).notNull().defaultGenerateUuid().primaryKey(),
  name: string('name', { length: 'max' }).notNull(),
  capacity: int64('capacity'),
});
`;

let harness: KitEmulatorHarness;
let workDir: string;

beforeAll(async () => {
  harness = await startKitEmulator();
  workDir = join(TMP_ROOT, randomUUID().slice(0, 8));
  await mkdir(workDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe('generate -> migrate', () => {
  it('applies a two-step migration sequence and is idempotent', async () => {
    const out = join(workDir, 'migrations');
    const schemaV1 = join(workDir, 'schema-v1.ts');
    await writeFile(schemaV1, SCHEMA_V1);

    const first = await generate(
      { schema: [schemaV1], out },
      { name: 'init', now: new Date('2026-07-30T10:00:00Z') },
    );
    expect(first.folder).not.toBeNull();

    const { config } = await harness.createDatabase('kit-migrate');
    const applied = await migrate({ out, database: config });
    expect(applied.applied).toEqual(['20260730100000_init']);

    // Evolve: a new table on top of the first migration.
    const schemaV2 = join(workDir, 'schema-v2.ts');
    await writeFile(schemaV2, SCHEMA_V2);
    const second = await generate(
      { schema: [schemaV2], out },
      { name: 'evolve', now: new Date('2026-07-30T11:00:00Z') },
    );
    expect(second.statements.some((statement) => statement.includes('CREATE TABLE `venues`'))).toBe(
      true,
    );

    const appliedSecond = await migrate({ out, database: config });
    expect(appliedSecond.applied).toEqual(['20260730110000_evolve']);

    // Idempotency: a re-run applies nothing.
    const third = await migrate({ out, database: config });
    expect(third.applied).toEqual([]);
  });

  it('round-trips pull: pull -> generate produces an empty diff', async () => {
    const { config } = await harness.createDatabase('kit-pull');
    const out = join(workDir, 'pull-setup');
    const schemaV1 = join(workDir, 'schema-pull.ts');
    await writeFile(schemaV1, SCHEMA_V1);
    await generate({ schema: [schemaV1], out }, { name: 'init' });
    await migrate({ out, database: config });

    const pulledOut = join(workDir, 'pulled');
    const result = await pull({ out: pulledOut, database: config });
    const emitted = await readFile(result.schemaFile, 'utf8');
    expect(emitted).toContain("spannerTable(\n  'albums'");
    expect(emitted).toContain('interleaveInParent(singers');
    expect(result.tables).toBe(2);

    const regenerate = await generate({ schema: [result.schemaFile], out: pulledOut });
    expect(regenerate.folder).toBeNull();
    expect(regenerate.statements).toEqual([]);
  });
});

describe('push', () => {
  it('prints the plan without applying, then applies with yes', async () => {
    const { config } = await harness.createDatabase('kit-push');
    const schemaV1 = join(workDir, 'schema-push.ts');
    await writeFile(schemaV1, SCHEMA_V1);

    const dryRun = await push({ schema: [schemaV1], database: config });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.statements.some((statement) => statement.includes('CREATE TABLE `singers`'))).toBe(
      true,
    );

    const applied = await push({ schema: [schemaV1], database: config }, { yes: true });
    expect(applied.applied).toBe(true);

    const noop = await push({ schema: [schemaV1], database: config }, { yes: true });
    expect(noop.statements).toEqual([]);
    expect(noop.applied).toBe(false);
  });
});
