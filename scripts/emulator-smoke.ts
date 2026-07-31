/**
 * Smoke test: runs `SELECT 1` through @google-cloud/spanner against the emulator.
 *
 * Usage:
 *   SPANNER_EMULATOR_HOST=localhost:9010 node scripts/emulator-smoke.ts
 *
 * Requires the instance/database from scripts/emulator-bootstrap.ts.
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
  const database = spanner.instance(INSTANCE_ID).database(DATABASE_ID)

  const [rows] = await database.run({ sql: 'SELECT 1 AS one' })
  const result = rows.map((row) => row.toJSON())
  console.log('Query result:', JSON.stringify(result))

  await database.close()
  spanner.close()

  if (result.length === 1 && result[0].one === 1) {
    console.log('SMOKE TEST PASSED')
  } else {
    console.error('SMOKE TEST FAILED: unexpected result')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err)
  process.exit(1)
})
