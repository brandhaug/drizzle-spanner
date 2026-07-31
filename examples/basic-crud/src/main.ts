// CRUD and a read-write transaction against the Spanner emulator. The
// schema was applied by `drizzle-spanner-kit migrate` (see package.json's
// start script); the migration folder was produced by
// `drizzle-spanner-kit generate`.
import assert from 'node:assert/strict'
import { Spanner } from '@google-cloud/spanner'
import { eq } from 'drizzle-orm/sql/expressions'
import { commitTimestamp, drizzle } from 'drizzle-spanner'

import { tasks } from './schema.ts'

process.env.SPANNER_EMULATOR_HOST ??= 'localhost:9010'

const spanner = new Spanner({
  projectId: process.env.SPANNER_PROJECT_ID ?? 'example-project'
})
const database = spanner
  .instance(process.env.SPANNER_INSTANCE_ID ?? 'example-instance')
  .database(process.env.SPANNER_DATABASE_ID ?? 'basic-crud')

const db = drizzle(database)

// Start clean so the example can be re-run against a long-lived emulator
// (a bare delete affects all rows, as in every drizzle dialect).
await db.delete(tasks)

// Create: .returning() compiles to THEN RETURN, so the generated UUID
// comes back without a second query. A commitTimestamp() column cannot be
// part of THEN RETURN — the value does not exist until the commit.
const [created] = await db
  .insert(tasks)
  .values({ title: 'write the milestone-4 examples' })
  .returning({ id: tasks.id, title: tasks.title, done: tasks.done })
assert.ok(created, 'insert returned a row')
console.log('created:', created.id, created.title)

// Read.
const open = await db.select().from(tasks).where(eq(tasks.done, false))
assert.equal(open.length, 1)

// Update.
await db
  .update(tasks)
  .set({ done: true, updatedAt: commitTimestamp() })
  .where(eq(tasks.id, created.id))

// Read-write transaction: the callback re-executes automatically when
// Spanner aborts it under contention, so it must be free of external side
// effects — queries only.
const followUpTitle = 'ship milestone 4'
await db.transaction(async (tx) => {
  const [done] = await tx.select().from(tasks).where(eq(tasks.id, created.id))
  assert.equal(done?.done, true)
  await tx.insert(tasks).values({ title: followUpTitle, updatedAt: commitTimestamp() })
})

const all = await db.select().from(tasks).orderBy(tasks.title)
assert.deepEqual(
  all.map((task) => [task.title, task.done]),
  [
    [followUpTitle, false],
    ['write the milestone-4 examples', true]
  ]
)

// Delete.
await db.delete(tasks).where(eq(tasks.done, true))
const remaining = await db.$count(tasks)
assert.equal(remaining, 1)

console.log('basic-crud example passed')
await database.close()
spanner.close()
