import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../../src/index.js';
import { parseSnapshot } from '../../src/snapshot.js';

const SCHEMA_V1 = `
import { spannerTable, string } from 'drizzle-spanner';

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
});
`;

const SCHEMA_V2 = `
import { int64, spannerTable, string } from 'drizzle-spanner';

export const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  plays: int64('plays'),
});
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drizzle-spanner-kit-generate-'));
  const schemaPath = join(dir, 'schema.ts');
  const out = join(dir, 'drizzle');
  await writeFile(schemaPath, SCHEMA_V1);
  return { dir, schemaPath, out };
}

describe('generate', () => {
  it('writes a timestamped folder with migration.sql and snapshot.json', async () => {
    const { schemaPath, out } = await setup();
    const result = await generate(
      { schema: [schemaPath], out },
      { name: 'init', now: new Date('2026-07-30T10:00:00Z') },
    );
    expect(result.folder).toBe(join(out, '20260730100000_init'));
    const sql = await readFile(join(result.folder!, 'migration.sql'), 'utf8');
    expect(sql).toBe(
      'CREATE TABLE `singers` (\n' +
        '  `id` STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),\n' +
        '  `name` STRING(MAX) NOT NULL\n' +
        ') PRIMARY KEY (`id`);\n',
    );
    const snapshot = parseSnapshot(
      await readFile(join(result.folder!, 'snapshot.json'), 'utf8'),
      'snapshot.json',
    );
    expect(snapshot.prevIds).toEqual([]);
    expect(snapshot.ddl.some((entity) => entity.entityType === 'tables')).toBe(true);
  });

  it('produces no folder when the schema is unchanged', async () => {
    const { schemaPath, out } = await setup();
    await generate({ schema: [schemaPath], out }, { name: 'init' });
    const second = await generate({ schema: [schemaPath], out }, { name: 'noop' });
    expect(second.folder).toBeNull();
    expect(second.statements).toEqual([]);
    expect(await readdir(out)).toHaveLength(1);
  });

  it('chains prevIds and separates statements with the breakpoint marker', async () => {
    const { dir, schemaPath, out } = await setup();
    const first = await generate(
      { schema: [schemaPath], out },
      { name: 'init', now: new Date('2026-07-30T10:00:00Z') },
    );
    const firstSnapshot = parseSnapshot(
      await readFile(join(first.folder!, 'snapshot.json'), 'utf8'),
      'snapshot.json',
    );

    const schemaV2Path = join(dir, 'schema-v2.ts');
    await writeFile(schemaV2Path, SCHEMA_V2);
    const second = await generate(
      { schema: [schemaV2Path], out },
      { name: 'add_plays', now: new Date('2026-07-30T11:30:05Z') },
    );
    expect(second.folder).toBe(join(out, '20260730113005_add_plays'));
    expect(second.statements).toEqual(['ALTER TABLE `singers` ADD COLUMN `plays` INT64']);
    const secondSnapshot = parseSnapshot(
      await readFile(join(second.folder!, 'snapshot.json'), 'utf8'),
      'snapshot.json',
    );
    expect(secondSnapshot.prevIds).toEqual([firstSnapshot.id]);
  });
});
