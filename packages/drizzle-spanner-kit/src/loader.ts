import { pathToFileURL } from 'node:url'

/**
 * Imports the schema module(s) and merges their exports. TypeScript modules
 * load through the runtime's native TS support (Node >= 22.18, Bun).
 */
export async function loadSchemaExports(
  paths: string[]
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {}
  for (const path of paths) {
    let module: Record<string, unknown>
    try {
      module = (await import(pathToFileURL(path).href)) as Record<string, unknown>
    } catch (error) {
      throw new Error(`drizzle-spanner-kit: failed to load schema module ${path}`, {
        cause: error
      })
    }
    for (const [name, value] of Object.entries(module)) {
      merged[`${path}:${name}`] = value
    }
  }
  return merged
}
