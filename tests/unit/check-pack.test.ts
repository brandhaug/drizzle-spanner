import { describe, expect, it } from 'vitest'

import { findPackViolations } from '../../scripts/check-pack.js'

// The published tarball may contain dist/ plus the standard metadata files
// and nothing else (spec: package layout — `files` whitelist). CI runs
// `npm pack --dry-run --json` through this validator for both packages.
describe('findPackViolations', () => {
  it('accepts dist files and the standard metadata files', () => {
    expect(
      findPackViolations([
        'package.json',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
        'dist/index.js',
        'dist/index.d.ts',
        'dist/columns/string.js'
      ])
    ).toEqual([])
  })

  it('flags anything outside dist and the metadata whitelist', () => {
    expect(
      findPackViolations([
        'package.json',
        'dist/index.js',
        'src/index.ts',
        'tsconfig.json',
        '.env'
      ])
    ).toEqual(['src/index.ts', 'tsconfig.json', '.env'])
  })

  it('flags a tarball with no dist output at all', () => {
    expect(findPackViolations(['package.json', 'README.md'])).toEqual([
      'no dist/ files in the tarball'
    ])
  })
})
