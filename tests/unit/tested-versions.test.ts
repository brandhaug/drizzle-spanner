import { describe, expect, it } from 'bun:test'

import {
  renderTestedVersionsTable,
  replaceTestedVersions
} from '../../scripts/sync-tested-versions.js'

// The README's tested-versions table is generated from the same file that
// drives the CI matrices (.github/tested-versions.json). These tests pin the
// rendered shape so the --check mode in CI fails when either side drifts.
describe('renderTestedVersionsTable', () => {
  it('renders one row per drizzle-orm version with the runtime set', () => {
    const table = renderTestedVersionsTable({
      'drizzle-orm': ['1.0.0-beta.22'],
      node: ['22', '24'],
      bun: true
    })
    expect(table).toBe(
      [
        '',
        '| drizzle-orm     | Runtimes              |',
        '| --------------- | --------------------- |',
        '| `1.0.0-beta.22` | Node 22, Node 24, Bun |',
        ''
      ].join('\n')
    )
  })

  it('renders multiple versions and omits Bun when disabled', () => {
    const table = renderTestedVersionsTable({
      'drizzle-orm': ['1.0.0-beta.22', '1.0.0-beta.23'],
      node: ['24'],
      bun: false
    })
    expect(table).toBe(
      [
        '',
        '| drizzle-orm     | Runtimes |',
        '| --------------- | -------- |',
        '| `1.0.0-beta.22` | Node 24  |',
        '| `1.0.0-beta.23` | Node 24  |',
        ''
      ].join('\n')
    )
  })
})

describe('replaceTestedVersions', () => {
  const markers = (body: string) =>
    `before\n\n<!-- tested-versions:start -->\n${body}\n<!-- tested-versions:end -->\n\nafter\n`

  it('replaces the content between the markers', () => {
    const updated = replaceTestedVersions(markers('| stale |'), '| fresh |')
    expect(updated).toBe(markers('| fresh |'))
  })

  it('is idempotent', () => {
    const once = replaceTestedVersions(markers('| stale |'), '| fresh |')
    expect(replaceTestedVersions(once, '| fresh |')).toBe(once)
  })

  it('throws when the markers are missing', () => {
    expect(() => replaceTestedVersions('no markers here', '| x |')).toThrow(
      /tested-versions/
    )
  })
})
