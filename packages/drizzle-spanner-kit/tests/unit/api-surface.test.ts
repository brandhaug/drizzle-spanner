import { describe, expect, it } from 'bun:test'

import * as root from '../../src/index.js'

// The kit's public API is the config helpers, the four commands for
// programmatic use, and the typed refusal. DDL/snapshot/introspection
// machinery is internal to the CLI.
const PUBLIC_EXPORTS = [
  'DiffRefusedError',
  'defineConfig',
  'generate',
  'loadConfig',
  'migrate',
  'pull',
  'push'
]

describe('drizzle-spanner-kit public API surface', () => {
  it('the package root exports exactly the audited public names', () => {
    expect(Object.keys(root).sort()).toEqual(PUBLIC_EXPORTS)
  })
})
