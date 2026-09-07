import { describe, expect, it } from 'bun:test'

import { findReleaseIssues } from '../../scripts/release-check.js'

// Both packages release in lockstep from one v<version> tag. The release
// workflow runs this check before publishing.
const pkg = (name: string, version: string, changelog: string) => ({
  name,
  version,
  changelog
})

describe('findReleaseIssues', () => {
  it('passes when the tag, both versions, and both changelogs agree', () => {
    expect(
      findReleaseIssues('v0.1.0', [
        pkg(
          'drizzle-spanner',
          '0.1.0',
          '# Changelog\n\n## 0.1.0\n\n- Initial release.\n'
        ),
        pkg(
          'drizzle-spanner-kit',
          '0.1.0',
          '# Changelog\n\n## 0.1.0\n\n- Initial release.\n'
        )
      ])
    ).toEqual([])
  })

  it('accepts release-please linked version headings', () => {
    expect(
      findReleaseIssues('v0.2.0', [
        pkg(
          'drizzle-spanner',
          '0.2.0',
          '## [0.2.0](https://github.com/brandhaug/drizzle-spanner/compare/v0.1.0...v0.2.0) (2026-09-07)\n'
        )
      ])
    ).toEqual([])
  })

  it('does not match another version with the same prefix', () => {
    expect(
      findReleaseIssues('v0.1.0', [pkg('drizzle-spanner', '0.1.0', '## 0.1.01\n')])
    ).toHaveLength(1)
  })

  it('rejects a tag that is not v<semver>', () => {
    expect(findReleaseIssues('0.1.0', [])).toEqual([
      "tag '0.1.0' is not of the form v<semver>"
    ])
  })

  it('flags a package whose version differs from the tag', () => {
    expect(
      findReleaseIssues('v0.2.0', [pkg('drizzle-spanner', '0.1.0', '## 0.2.0\n')])
    ).toEqual(['drizzle-spanner is at 0.1.0 but the tag says 0.2.0'])
  })

  it('flags a package whose changelog has no entry for the version', () => {
    expect(
      findReleaseIssues('v0.1.0', [
        pkg('drizzle-spanner', '0.1.0', '# Changelog\n\n## 0.0.9\n')
      ])
    ).toEqual(["drizzle-spanner's CHANGELOG.md has no '## 0.1.0' entry"])
  })
})
