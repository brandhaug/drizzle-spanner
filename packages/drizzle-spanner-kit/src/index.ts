// The package root is audited public API (see tests/unit/api-surface.test.ts):
// the config helpers, the four commands for programmatic use, and the typed
// refusal. Snapshot/DDL/introspection machinery is internal to the CLI.
export { generate } from './commands/generate.js'
export type { GenerateOptions, GenerateResult } from './commands/generate.js'
export { migrate } from './commands/migrate.js'
export { pull } from './commands/pull.js'
export type { PullOptions, PullResult } from './commands/pull.js'
export { push } from './commands/push.js'
export type { PushOptions, PushResult } from './commands/push.js'
export { defineConfig, loadConfig } from './config.js'
export type {
  ResolvedSpannerKitConfig,
  SpannerKitConfig,
  SpannerKitDatabaseConfig
} from './config.js'
export { DiffRefusedError } from './differ.js'
export type { DiffDiagnostic, RenameCandidate } from './differ.js'
