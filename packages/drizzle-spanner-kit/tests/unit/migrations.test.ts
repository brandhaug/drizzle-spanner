import { describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLatestSnapshot, writeMigrationFolder } from '../../src/migrations.js'
import { createSnapshot } from '../../src/snapshot.js'

const timestamp = '20260907120000'
const snapshot = createSnapshot([])

describe('migration publication', () => {
  it('rejects names that migration discovery cannot read', async () => {
    const out = await fs.mkdtemp(join(tmpdir(), 'spanner-migrations-'))
    try {
      for (const name of [
        'line\nbreak',
        'line\rbreak',
        'line\u2028break',
        'line\u2029break',
        'path/name',
        String.raw`path\name`
      ]) {
        await expect(
          writeMigrationFolder(out, timestamp, name, ['FIRST'], snapshot)
        ).rejects.toThrow('invalid migration')
      }
      expect(await fs.readdir(out)).toEqual([])
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite a published migration', async () => {
    const out = await fs.mkdtemp(join(tmpdir(), 'spanner-migrations-'))
    try {
      const folder = await writeMigrationFolder(
        out,
        timestamp,
        'init',
        ['FIRST'],
        snapshot
      )
      await expect(
        writeMigrationFolder(out, timestamp, 'init', ['SECOND'], snapshot)
      ).rejects.toThrow('already exists')
      expect(await fs.readFile(join(folder, 'migration.sql'), 'utf8')).toBe('FIRST;\n')
      expect(await readLatestSnapshot(out)).toEqual(snapshot)
      expect(await fs.readdir(out)).toEqual([`${timestamp}_init`])
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  })

  it('publishes only one complete migration when writers race for the same name', async () => {
    const out = await fs.mkdtemp(join(tmpdir(), 'spanner-migrations-'))
    try {
      const results = await Promise.allSettled([
        writeMigrationFolder(out, timestamp, 'init', ['FIRST'], snapshot),
        writeMigrationFolder(out, timestamp, 'init', ['SECOND'], snapshot)
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(await readLatestSnapshot(out)).toEqual(snapshot)
      expect(await fs.readdir(out)).toEqual([`${timestamp}_init`])
      expect(['FIRST;\n', 'SECOND;\n']).toContain(
        await fs.readFile(join(out, `${timestamp}_init`, 'migration.sql'), 'utf8')
      )
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  })

  it('cleans up a failed second file write without publishing a partial migration', async () => {
    const out = await fs.mkdtemp(join(tmpdir(), 'spanner-migrations-'))
    const writeFile = fs.writeFile
    const write = spyOn(fs, 'writeFile').mockImplementation((path, data, options) => {
      if (String(path).endsWith('snapshot.json')) {
        return Promise.reject(new Error('disk write failed'))
      }
      return writeFile(path, data, options)
    })
    try {
      await expect(
        writeMigrationFolder(out, timestamp, 'init', ['FIRST'], snapshot)
      ).rejects.toThrow('disk write failed')
      expect(await readLatestSnapshot(out)).toBeNull()
      expect(await fs.readdir(out)).toEqual([])
      write.mockRestore()
      await writeMigrationFolder(out, timestamp, 'init', ['RETRY'], snapshot)
      expect(await readLatestSnapshot(out)).toEqual(snapshot)
    } finally {
      write.mockRestore()
      await fs.rm(out, { recursive: true, force: true })
    }
  })
})
