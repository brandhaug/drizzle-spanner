import { access } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Connection coordinates of the target database. */
export interface SpannerKitDatabaseConfig {
  project: string
  instance: string
  database: string
  /** Routes the client at the emulator (`host:port`) instead of live Spanner. */
  emulatorHost?: string
}

/** Shape of `drizzle-spanner.config.ts` as the user writes it. */
export interface SpannerKitConfig {
  /** Schema module path(s) exporting `spannerTable` / `sequence` values. */
  schema: string | Array<string>
  /** Migrations folder; defaults to `./drizzle`. */
  out?: string
  /** Required by `migrate`, `pull` and `push`; `generate` runs without it. */
  database?: SpannerKitDatabaseConfig
}

/** `SpannerKitConfig` after validation, with paths resolved and defaults applied. */
export interface ResolvedSpannerKitConfig {
  schema: Array<string>
  out: string
  database?: SpannerKitDatabaseConfig
}

/** Identity helper for typed `drizzle-spanner.config.ts` files. */
export function defineConfig(config: SpannerKitConfig): SpannerKitConfig {
  return config
}

function validateDatabase(database: unknown): SpannerKitDatabaseConfig | undefined {
  if (database === undefined) {
    return undefined
  }
  const candidate = database as Partial<SpannerKitDatabaseConfig>
  for (const key of ['project', 'instance', 'database'] as const) {
    if (typeof candidate[key] !== 'string' || candidate[key].length === 0) {
      throw new Error(
        `drizzle-spanner-kit config: database.${key} must be a non-empty string`
      )
    }
  }
  return candidate as SpannerKitDatabaseConfig
}

/**
 * Loads and validates a `drizzle-spanner.config.ts` (or `.js`/`.mjs`) file.
 * Relative `schema` and `out` paths resolve against the config file's
 * directory. TypeScript configs load through the runtime's native TS support
 * (Node >= 22.18, Bun).
 */
export async function loadConfig(
  configPath: string
): Promise<ResolvedSpannerKitConfig> {
  const absolutePath = isAbsolute(configPath) ? configPath : resolve(configPath)
  try {
    await access(absolutePath)
  } catch {
    throw new Error(`drizzle-spanner-kit: config file not found at ${absolutePath}`)
  }
  const module = (await import(pathToFileURL(absolutePath).href)) as {
    default?: SpannerKitConfig
  }
  const config = module.default
  if (!config || typeof config !== 'object') {
    throw new Error(
      `drizzle-spanner-kit: ${absolutePath} must default-export a config object (use defineConfig)`
    )
  }
  const baseDir = dirname(absolutePath)
  const schemaInput =
    typeof config.schema === 'string'
      ? [config.schema]
      : (config.schema as Array<string> | undefined)
  if (!schemaInput || schemaInput.length === 0) {
    throw new Error(
      'drizzle-spanner-kit config: schema must name at least one schema module path'
    )
  }
  return {
    schema: schemaInput.map((path) => resolve(baseDir, path)),
    out: resolve(baseDir, config.out ?? './drizzle'),
    database: validateDatabase(config.database)
  }
}

/** The database section, or a command-scoped error naming what is missing. */
export function requireDatabase(
  config: Pick<ResolvedSpannerKitConfig, 'database'>,
  command: string
): SpannerKitDatabaseConfig {
  if (!config.database) {
    throw new Error(
      `drizzle-spanner-kit ${command}: the config has no database section (project, instance, database)`
    )
  }
  return config.database
}
