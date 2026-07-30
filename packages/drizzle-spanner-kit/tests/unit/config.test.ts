import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/index.js';

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drizzle-spanner-kit-'));
  const path = join(dir, 'drizzle-spanner.config.ts');
  await writeFile(path, contents);
  return path;
}

describe('loadConfig', () => {
  it('loads a defineConfig default export and resolves paths against the config file', async () => {
    const path = await writeConfig(`
      export default {
        schema: './schema.ts',
        out: './migrations',
        database: {
          project: 'proj',
          instance: 'inst',
          database: 'db',
          emulatorHost: 'localhost:9010',
        },
      };
    `);
    const config = await loadConfig(path);
    expect(config.schema).toEqual([join(path, '..', 'schema.ts')]);
    expect(config.out).toBe(join(path, '..', 'migrations'));
    expect(config.database).toEqual({
      project: 'proj',
      instance: 'inst',
      database: 'db',
      emulatorHost: 'localhost:9010',
    });
  });

  it('defaults out to ./drizzle and accepts an array of schema paths', async () => {
    const path = await writeConfig(`
      export default {
        schema: ['./a.ts', './b.ts'],
        database: { project: 'p', instance: 'i', database: 'd' },
      };
    `);
    const config = await loadConfig(path);
    expect(config.schema).toEqual([join(path, '..', 'a.ts'), join(path, '..', 'b.ts')]);
    expect(config.out).toBe(join(path, '..', 'drizzle'));
  });

  it('rejects a config without schema', async () => {
    const path = await writeConfig(`export default { database: { project: 'p', instance: 'i', database: 'd' } };`);
    await expect(loadConfig(path)).rejects.toThrow(/schema/);
  });

  it('rejects a missing config file with a clear error', async () => {
    await expect(loadConfig('/nonexistent/drizzle-spanner.config.ts')).rejects.toThrow(
      /config/i,
    );
  });
});
