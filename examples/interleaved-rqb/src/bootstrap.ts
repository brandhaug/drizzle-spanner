// Creates the emulator instance and database this example runs against.
// Idempotent: an existing instance/database is left as-is.
import { Spanner } from '@google-cloud/spanner';

process.env.SPANNER_EMULATOR_HOST ??= 'localhost:9010';

const PROJECT = process.env.SPANNER_PROJECT_ID ?? 'example-project';
const INSTANCE = process.env.SPANNER_INSTANCE_ID ?? 'example-instance';
const DATABASE = process.env.SPANNER_DATABASE_ID ?? 'interleaved-rqb';

const spanner = new Spanner({ projectId: PROJECT });
const instance = spanner.instance(INSTANCE);

const [instanceExists] = await instance.exists();
if (!instanceExists) {
  const [, operation] = await instance.create({
    config: 'emulator-config',
    nodes: 1,
    displayName: INSTANCE,
  });
  await operation.promise();
}

const database = instance.database(DATABASE);
const [databaseExists] = await database.exists();
if (!databaseExists) {
  const [, operation] = await instance.createDatabase(DATABASE);
  await operation.promise();
}

await database.close();
spanner.close();
console.log(`Emulator ready: ${PROJECT}/${INSTANCE}/${DATABASE}`);
