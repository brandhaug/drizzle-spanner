import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Spanner } from '@google-cloud/spanner';
import type { Database } from '@google-cloud/spanner';
import { drizzle } from '../../src/index.js';
import type { SpannerDatabase, SpannerDriverDatabase } from '../../src/index.js';

const EMULATOR_IMAGE = 'gcr.io/cloud-spanner-emulator/emulator:latest';

export interface EmulatorHarness {
  db: SpannerDatabase;
  database: Database;
  cleanup(): Promise<void>;
}

/**
 * One emulator per test worker: each test file starts its own container
 * (emulator state is in-memory and read-write transactions serialize, so
 * isolation is free and mandatory). When SPANNER_EMULATOR_HOST is already set
 * (docker-compose dev loop, or the Bun run), that emulator is reused and the
 * file gets its own randomly named instance/database instead.
 */
export async function startEmulator(ddl: string[]): Promise<EmulatorHarness> {
  let container: StartedTestContainer | undefined;
  let host = process.env.SPANNER_EMULATOR_HOST;
  if (!host) {
    // The emulator image is distroless, so testcontainers' internal port
    // probe cannot run; wait on the gRPC server's log line instead.
    container = await new GenericContainer(EMULATOR_IMAGE)
      .withExposedPorts(9010)
      .withWaitStrategy(Wait.forLogMessage(/gRPC server listening/i))
      .start();
    host = `${container.getHost()}:${container.getMappedPort(9010)}`;
  }
  process.env.SPANNER_EMULATOR_HOST = host;

  const suffix = randomUUID().slice(0, 8);
  const spanner = new Spanner({ projectId: 'test-project' });
  const instance = spanner.instance(`test-instance-${suffix}`);
  const [, instanceOperation] = await instance.create({
    config: 'emulator-config',
    nodes: 1,
    displayName: 'drizzle-spanner tests',
  });
  await instanceOperation.promise();

  const [database, databaseOperation] = await instance.createDatabase(`test-db-${suffix}`);
  await databaseOperation.promise();

  if (ddl.length > 0) {
    const [ddlOperation] = await database.updateSchema(ddl);
    await ddlOperation.promise();
  }

  return {
    db: drizzle(database as unknown as SpannerDriverDatabase),
    database,
    async cleanup() {
      await database.close();
      spanner.close();
      await container?.stop();
    },
  };
}
