import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Spanner } from '@google-cloud/spanner';
import type { Database, Instance } from '@google-cloud/spanner';
import type { SpannerKitDatabaseConfig } from '../../src/index.js';

const EMULATOR_IMAGE = 'gcr.io/cloud-spanner-emulator/emulator:latest';

// Captured at import time, same as the runtime harness: a stopped container
// from an earlier test file must not masquerade as an external emulator.
const EXTERNAL_EMULATOR_HOST = process.env.SPANNER_EMULATOR_HOST;

export interface KitEmulatorHarness {
  host: string;
  project: string;
  instanceName: string;
  /** Creates a database on the emulator and returns the kit config for it. */
  createDatabase(name: string): Promise<{ config: SpannerKitDatabaseConfig; database: Database }>;
  cleanup(): Promise<void>;
}

/** One emulator per test file, exposing connection coordinates for the kit. */
export async function startKitEmulator(): Promise<KitEmulatorHarness> {
  let container: StartedTestContainer | undefined;
  let host = EXTERNAL_EMULATOR_HOST;
  if (!host) {
    container = await new GenericContainer(EMULATOR_IMAGE)
      .withExposedPorts(9010)
      .withWaitStrategy(Wait.forLogMessage(/gRPC server listening/i))
      .start();
    host = `${container.getHost()}:${container.getMappedPort(9010)}`;
  }
  process.env.SPANNER_EMULATOR_HOST = host;

  const project = 'test-project';
  const suffix = randomUUID().slice(0, 8);
  const instanceName = `kit-instance-${suffix}`;
  const spanner = new Spanner({ projectId: project });
  const instance: Instance = spanner.instance(instanceName);
  const [, operation] = await instance.create({
    config: 'emulator-config',
    nodes: 1,
    displayName: 'drizzle-spanner-kit tests',
  });
  await operation.promise();

  const databases: Database[] = [];
  return {
    host,
    project,
    instanceName,
    async createDatabase(name: string) {
      const [database, databaseOperation] = await instance.createDatabase(`${name}-${suffix}`);
      await databaseOperation.promise();
      databases.push(database);
      return {
        config: {
          project,
          instance: instanceName,
          database: `${name}-${suffix}`,
          emulatorHost: host,
        },
        database,
      };
    },
    async cleanup() {
      for (const database of databases) await database.close();
      spanner.close();
      await container?.stop();
    },
  };
}
