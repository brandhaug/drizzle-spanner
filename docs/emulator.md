# Spanner emulator

This document tells you how to operate the local Cloud Spanner emulator.
The emulator runs in Docker. The scripts use `@google-cloud/spanner`.
The environment gives the same result on each machine.

## Requirements

You must have these tools before you start:

- Docker with Docker Compose
- Node.js 22.6 or later (the scripts are TypeScript files, and Node runs
  them directly)
- npm

Install the dependencies one time:

1. Open a terminal in the repository root.
2. Run `npm install`.

## Start the emulator

Do these steps to start the emulator:

1. Run `docker compose up -d` (or `npm run emulator:up`).
2. Wait until the container `spanner-emulator` is in the state `running`.
   Run `docker compose ps` to see the state.

The emulator listens on these ports:

| Port | Protocol | Use                          |
| ---- | -------- | ---------------------------- |
| 9010 | gRPC     | Client libraries and drivers |
| 9020 | REST     | HTTP API                     |

## Stop the emulator

Run `docker compose down` (or `npm run emulator:down`) to stop and remove
the container.

<!-- prettier-ignore -->
> [!WARNING]
> The emulator keeps all data in memory. When you stop or restart the
> container, the emulator deletes all instances, databases, and rows.
> Run the bootstrap script again after each restart.

## Create the instance and the database

The bootstrap script creates a Spanner instance and a database on the
emulator. The script does not change an instance or a database that
already exists.

1. Make sure the emulator is running.
2. Run `SPANNER_EMULATOR_HOST=localhost:9010 npm run emulator:bootstrap`.
3. Read the output. The output shows `Bootstrap complete.` on success.

The script uses these default identifiers. Set the environment variables
to use different values.

| Environment variable  | Default value   |
| --------------------- | --------------- |
| `SPANNER_PROJECT_ID`  | `test-project`  |
| `SPANNER_INSTANCE_ID` | `test-instance` |
| `SPANNER_DATABASE_ID` | `test-database` |

## Run the smoke test

The smoke test sends the query `SELECT 1` through `@google-cloud/spanner`
to the emulator.

1. Make sure the emulator is running.
2. Make sure the bootstrap script has completed.
3. Run `SPANNER_EMULATOR_HOST=localhost:9010 npm run emulator:smoke`.
4. Read the output. The output shows `SMOKE TEST PASSED` on success.

To run the smoke test with Bun, run
`SPANNER_EMULATOR_HOST=localhost:9010 bun run scripts/emulator-smoke.ts`.
The test passes on Bun 1.3.3. The gRPC stack of `@google-cloud/spanner`
operates correctly on Bun.

## Emulator limits

We found these limits during the setup of this environment:

- The emulator keeps data in memory only. A restart of the container
  deletes all state. After a restart, a query fails with the gRPC error
  `NOT_FOUND (code 5): Instance not found`. You must run the bootstrap
  script again.
- The emulator does not validate credentials. The client library detects
  `SPANNER_EMULATOR_HOST` and does not send real credentials. Do not point
  the scripts at a production project.
- The emulator accepts only local instance configurations. The bootstrap
  script uses the configuration name `emulator-config`. Real region
  configurations such as `regional-europe-west1` are not available.

Google documents more limits that we did not measure in this repository,
for example: one read-write transaction at a time per database, no query
plan or query statistics, and partial support for some SQL functions. See
the [emulator documentation](https://cloud.google.com/spanner/docs/emulator)
for the full list.
