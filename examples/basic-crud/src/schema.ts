// fallow-ignore-file unused-file
// Loaded dynamically by drizzle-spanner-kit (see drizzle-spanner.config.ts).
import { bool, spannerTable, string, timestamp } from 'drizzle-spanner'

// Spanner requires a primary key and has no auto-increment; a STRING(36)
// UUID key is the recommended default (monotonic keys hotspot Spanner's
// range-sharded storage).
// fallow-ignore-next-line unused-export
export const tasks = spannerTable('tasks', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  title: string('title', { length: 'max' }).notNull(),
  done: bool('done').notNull().default(false),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true })
})
