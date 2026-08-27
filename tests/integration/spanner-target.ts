import { randomUUID } from 'node:crypto'
import { GenericContainer, Wait } from 'testcontainers'
import { type StartedTestContainer } from 'testcontainers'
import { Spanner } from '@google-cloud/spanner'
import { type Instance } from '@google-cloud/spanner'

const EMULATOR_IMAGE = 'gcr.io/cloud-spanner-emulator/emulator:latest'

// Captured at import time: the harnesses mutate SPANNER_EMULATOR_HOST for the
// driver, and under single-process runners (bun test) a later test file must
// not mistake the previous file's stopped container for an externally managed
// emulator. The OWNED marker covers modules that load lazily after another
// harness already mutated the env.
const EXTERNAL_EMULATOR_HOST = process.env.DRIZZLE_SPANNER_TEST_OWNED
  ? undefined
  : process.env.SPANNER_EMULATOR_HOST

/** The Spanner instance integration tests run against. */
export interface SpannerTestTarget {
  spanner: Spanner
  instance: Instance
  project: string
  instanceName: string
  /** Set when the target is an emulator; absent on a real instance. */
  emulatorHost?: string
  /** Closes the client, drops an owned instance, stops an owned container. */
  stop(): Promise<void>
}

/**
 * Starts (or reuses) the Spanner instance a test file runs against.
 *
 * - `DRIZZLE_SPANNER_TEST_INSTANCE` set (the nightly job): the named real
 *   instance in `GOOGLE_CLOUD_PROJECT` is reused; the caller creates and
 *   deletes its own databases on it.
 * - Otherwise an emulator is used, with a fresh randomly named instance per
 *   test file (emulator state is in-memory and read-write transactions
 *   serialize, so isolation is free and mandatory). When
 *   `SPANNER_EMULATOR_HOST` is already set (docker-compose dev loop, or the
 *   Bun run) that emulator is reused; otherwise a container is started via
 *   testcontainers.
 */
export async function startSpannerTestTarget(
  namePrefix: string
): Promise<SpannerTestTarget> {
  const realInstance = process.env.DRIZZLE_SPANNER_TEST_INSTANCE
  if (realInstance) {
    const project = process.env.GOOGLE_CLOUD_PROJECT
    if (!project) {
      throw new Error(
        'DRIZZLE_SPANNER_TEST_INSTANCE requires GOOGLE_CLOUD_PROJECT to be set'
      )
    }
    const spanner = new Spanner({ projectId: project })
    return {
      spanner,
      instance: spanner.instance(realInstance),
      project,
      instanceName: realInstance,
      async stop() {
        await spanner.close()
      }
    }
  }

  let container: StartedTestContainer | undefined
  let host = EXTERNAL_EMULATOR_HOST
  if (!host) {
    // The emulator image is distroless, so testcontainers' internal port
    // probe cannot run; wait on the gRPC server's log line instead.
    container = await new GenericContainer(EMULATOR_IMAGE)
      .withExposedPorts(9010)
      .withWaitStrategy(Wait.forLogMessage(/gRPC server listening/i))
      .start()
    host = `${container.getHost()}:${container.getMappedPort(9010)}`
    process.env.DRIZZLE_SPANNER_TEST_OWNED = '1'
  }
  process.env.SPANNER_EMULATOR_HOST = host

  const project = 'test-project'
  const instanceName = `${namePrefix}-${randomUUID().slice(0, 8)}`
  const spanner = new Spanner({ projectId: project })
  const instance = spanner.instance(instanceName)
  const [, operation] = await instance.create({
    config: 'emulator-config',
    nodes: 1,
    displayName: `${namePrefix} tests`
  })
  await operation.promise()

  return {
    spanner,
    instance,
    project,
    instanceName,
    emulatorHost: host,
    async stop() {
      await spanner.close()
      await container?.stop()
    }
  }
}
