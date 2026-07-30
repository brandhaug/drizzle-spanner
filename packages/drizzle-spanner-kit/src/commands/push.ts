import { SpannerDdlError } from 'drizzle-spanner';
import type { ResolvedSpannerKitConfig } from '../config.js';
import { requireDatabase } from '../config.js';
import type { KitDriverDatabase } from '../connect.js';
import { connectDatabase } from '../connect.js';
import type { RenameResolver } from '../differ.js';
import { diffSnapshots } from '../differ.js';
import { introspectDatabase } from '../introspect.js';
import { loadSchemaExports } from '../loader.js';
import { serializeSchema } from '../serializer.js';

export interface PushOptions {
  /** Apply without asking; equivalent to answering yes. */
  yes?: boolean;
  /** Asked with the full DDL plan when `yes` is not set. */
  confirm?: (statements: string[]) => Promise<boolean>;
  resolveRename?: RenameResolver;
  acceptDrops?: boolean;
}

export interface PushResult {
  statements: string[];
  applied: boolean;
}

/** Applies one batched DDL operation, surfacing partial failure typed. */
export async function applyDdl(database: KitDriverDatabase, statements: string[]): Promise<void> {
  try {
    const [operation] = await database.updateSchema(statements);
    await operation.promise();
  } catch (error) {
    const metadata = (error as { metadata?: { commitTimestamps?: unknown[] } }).metadata;
    const statementIndex = Array.isArray(metadata?.commitTimestamps)
      ? metadata.commitTimestamps.length
      : undefined;
    throw new SpannerDdlError({
      message: `push failed to apply the DDL plan${
        statementIndex !== undefined && statements[statementIndex] !== undefined
          ? `; failed statement (index ${statementIndex}): ${statements[statementIndex]}`
          : ''
      }`,
      code: (error as { code?: number }).code,
      cause: error,
      statementIndex,
    });
  }
}

/**
 * `push`: diffs the schema module against the live database (introspect ->
 * snapshot -> differ) and applies the plan after confirmation. The full plan
 * is always computed first; nothing applies without `yes` or a confirmed
 * prompt. Inherits the differ's refuse-and-explain diagnostics.
 */
export async function push(
  config: Pick<ResolvedSpannerKitConfig, 'schema' | 'database'>,
  options: PushOptions = {},
): Promise<PushResult> {
  const databaseConfig = requireDatabase(config, 'push');
  const schemaExports = await loadSchemaExports(config.schema);
  const desired = serializeSchema(schemaExports);

  const connection = await connectDatabase(databaseConfig);
  try {
    const live = await introspectDatabase(connection.database);
    const { statements } = await diffSnapshots(live, desired, {
      resolveRename: options.resolveRename,
      acceptDrops: options.acceptDrops,
    });
    if (statements.length === 0) {
      return { statements, applied: false };
    }
    const confirmed =
      options.yes === true || (options.confirm ? await options.confirm(statements) : false);
    if (!confirmed) {
      return { statements, applied: false };
    }
    await applyDdl(connection.database, statements);
    return { statements, applied: true };
  } finally {
    await connection.close();
  }
}
