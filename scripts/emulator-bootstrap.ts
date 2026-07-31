/**
 * Creates a Spanner instance and database against the local emulator.
 *
 * Usage:
 *   SPANNER_EMULATOR_HOST=localhost:9010 node scripts/emulator-bootstrap.ts
 *
 * Idempotent: existing instance/database are left as-is.
 */
import { Spanner } from '@google-cloud/spanner'

const PROJECT_ID = process.env.SPANNER_PROJECT_ID ?? 'test-project'
const INSTANCE_ID = process.env.SPANNER_INSTANCE_ID ?? 'test-instance'
const DATABASE_ID = process.env.SPANNER_DATABASE_ID ?? 'test-database'

if (!process.env.SPANNER_EMULATOR_HOST) {
  process.env.SPANNER_EMULATOR_HOST = 'localhost:9010'
}

async function main() {
  console.log(`SPANNER_EMULATOR_HOST=${process.env.SPANNER_EMULATOR_HOST}`)
  const spanner = new Spanner({ projectId: PROJECT_ID })

  const instance = spanner.instance(INSTANCE_ID)
  const [instanceExists] = await instance.exists()
  if (instanceExists) {
    console.log(`Instance "${INSTANCE_ID}" already exists.`)
  } else {
    console.log(`Creating instance "${INSTANCE_ID}"...`)
    const [, operation] = await instance.create({
      config: 'emulator-config',
      nodes: 1,
      displayName: INSTANCE_ID
    })
    await operation.promise()
    console.log(`Instance "${INSTANCE_ID}" created.`)
  }

  const database = instance.database(DATABASE_ID)
  const [databaseExists] = await database.exists()
  if (databaseExists) {
    console.log(`Database "${DATABASE_ID}" already exists.`)
  } else {
    console.log(`Creating database "${DATABASE_ID}"...`)
    const [, operation] = await instance.createDatabase(DATABASE_ID)
    await operation.promise()
    console.log(`Database "${DATABASE_ID}" created.`)
  }

  await database.close()
  spanner.close()
  console.log('Bootstrap complete.')
}

main().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
