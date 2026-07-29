# Research: @google-cloud/spanner Node.js client capabilities

Resolves issue #4. Part of #1.

Package inspected: `@google-cloud/spanner` version 8.10.0.
Sources: package type definitions and compiled source in `build/src/`, the
[googleapis/nodejs-spanner](https://github.com/googleapis/nodejs-spanner) repository, the
[API reference](https://cloud.google.com/nodejs/docs/reference/spanner/latest), and
[Google Cloud Spanner docs](https://docs.cloud.google.com/spanner/docs).

## 1. Database.run and Database.runStream

`Database.run(query)` executes one SQL statement.
It returns a promise of `[rows, stats, metadata]`.
It accepts a string or an `ExecuteSqlRequest` object.
`Database.runStream(query)` returns a `PartialResultStream`.
The stream emits one `Row` object per row.
Both methods use a single-use read-only transaction by default.
Both methods accept `TimestampBounds` as a second argument.
DML is not allowed here.
Run DML inside a read-write transaction with `runUpdate` or `batchUpdate`.

```ts
const [rows] = await database.run({
  sql: 'SELECT id, name FROM users WHERE id = @id',
  params: { id: '42' },
  json: true, // return plain objects instead of Row instances
});

database
  .runStream({ sql: 'SELECT * FROM users', json: true })
  .on('data', (row) => console.log(row))
  .on('error', console.error)
  .on('end', () => {});
```

### Parameters and type hints

Parameters use the `@name` syntax in SQL.
Values go in the `params` map.
The client infers the Spanner type from the JavaScript value (`codec.getType`).
Inference rules: `number` (integer) → INT64, decimal `number`, `NaN`, `Infinity` → FLOAT64,
`boolean` → BOOL, `string` → STRING, `Buffer` → BYTES, `Date` → TIMESTAMP,
`SpannerDate` → DATE, `Numeric` → NUMERIC, arrays → ARRAY of the first element type.

**Sharp edge: untyped null.**
`getType(null)` returns `{ type: 'unspecified' }`.
Spanner rejects a query parameter with an unspecified type.
The request fails with `INVALID_ARGUMENT`.
The adapter must supply a type hint for every parameter that can be `null`.
Empty arrays have the same problem: the child type cannot be inferred.

```ts
const [rows] = await database.run({
  sql: 'SELECT * FROM users WHERE nickname = @nick',
  params: { nick: null },
  types: { nick: 'string' }, // required: null gives no type information
});
```

`types` accepts shorthand strings (`'int64'`, `'string'`, `'bool'`, `'float64'`,
`'float32'`, `'numeric'`, `'json'`, `'bytes'`, `'timestamp'`, `'date'`) or objects such as
`{ type: 'array', child: 'string' }` and structs.
The `Statement` interface also exposes a raw `paramTypes` map of
`google.spanner.v1.Type` values (see `build/src/transaction.d.ts`).

Source: [Transaction docs](https://cloud.google.com/nodejs/docs/reference/spanner/latest/spanner/transaction),
[queries doc](https://docs.cloud.google.com/spanner/docs/samples/spanner-query-with-parameter).

## 2. Read-write transactions: runTransactionAsync

`Database.runTransactionAsync(runFn)` runs a function inside a read-write transaction.
The client checks a session out of the pool.
The client passes a `Transaction` object to `runFn`.
The function must end with `transaction.commit()` or `transaction.rollback()`.
The return value of `runFn` becomes the return value of `runTransactionAsync`.

```ts
const rowCount = await database.runTransactionAsync(async (tx) => {
  const [count] = await tx.runUpdate({
    sql: 'UPDATE users SET name = @name WHERE id = @id',
    params: { name: 'Ada', id: '42' },
    types: { name: 'string', id: 'int64' },
  });
  await tx.commit();
  return count;
});
```

### Abort and retry semantics

Spanner aborts read-write transactions on lock conflicts.
The abort surfaces as gRPC status `ABORTED` (code 10).
The client retries the whole `runFn` automatically (`AsyncTransactionRunner`
in `build/src/transaction-runner.js`).
Retryable errors are `ABORTED`, "Session not found", and specific retryable
`INTERNAL` errors.
The retry delay comes from the server `google.rpc.retryinfo-bin` metadata when present.
Otherwise the client uses exponential backoff with jitter, capped at 32 seconds.
The default total timeout is 3,600,000 ms (1 hour).
Set `timeout` in `RunTransactionOptions` to change it.
After the timeout the client throws `DeadlineError`.

**Sharp edge: side effects.**
`runFn` can run many times.
The adapter must keep `runFn` free of non-idempotent side effects.
Drizzle's transaction callback API maps well here, but user code inside the
callback re-executes on retry.

Source: [transactions doc](https://docs.cloud.google.com/spanner/docs/transactions),
[transaction-runner.ts](https://github.com/googleapis/nodejs-spanner/blob/main/src/transaction-runner.ts).

## 3. Read-only transactions and timestamp bounds

`Database.getSnapshot(options)` returns a read-only `Snapshot` transaction.
Read-only transactions take no locks.
They never abort due to conflicts.
Call `snapshot.end()` to release the session back to the pool.

`TimestampBounds` (from `build/src/transaction.d.ts`):

| Option | Type | Meaning |
| --- | --- | --- |
| `strong` | boolean (default true) | Read all data committed before the read starts. |
| `exactStaleness` | number (ms) or `IDuration` | Read at a timestamp exactly this old. |
| `readTimestamp` | `PreciseDate` or `ITimestamp` | Read at this exact timestamp. |
| `maxStaleness` | number (ms) or `IDuration` | Bounded staleness. Single-use only. |
| `minReadTimestamp` | `PreciseDate` or `ITimestamp` | Read at a timestamp at or after this. Single-use only. |
| `returnReadTimestamp` | boolean (default true) | Populate `snapshot.readTimestamp`. |

**Sharp edge:** `maxStaleness` and `minReadTimestamp` are valid only for
single-use transactions (`database.run` / `database.runStream` directly).
`getSnapshot` rejects them because it begins a multi-use transaction.

```ts
// Exact staleness: read data as of 15 seconds ago.
const [snapshot] = await database.getSnapshot({ exactStaleness: 15000 });
try {
  const [rows] = await snapshot.run('SELECT * FROM users');
} finally {
  snapshot.end();
}

// Bounded staleness: only valid on single-use reads.
const [rows] = await database.run(
  { sql: 'SELECT * FROM users' },
  { maxStaleness: 10000 },
);
```

Source: [timestamp bounds doc](https://docs.cloud.google.com/spanner/docs/timestamp-bounds),
[Snapshot class reference](https://cloud.google.com/nodejs/docs/reference/spanner/latest/spanner/snapshot).

## 4. Mutations API

Mutations write rows without SQL.
They are cheaper than DML for bulk writes.
`Transaction` exposes `insert`, `update`, `upsert`, `replace`, and `deleteRows`.
These methods are synchronous.
They only queue the mutation locally.
The client sends all queued mutations in one `Commit` RPC when `commit()` runs.
The commit is atomic.

```ts
await database.runTransactionAsync(async (tx) => {
  tx.insert('users', { id: '1', name: 'Ada' });
  tx.upsert('users', [{ id: '2', name: 'Grace' }, { id: '3', name: 'Edsger' }]);
  tx.update('users', { id: '4', name: 'Barbara' });   // row must exist
  tx.replace('users', { id: '5', name: 'Alan' });     // deletes then inserts; unset columns become NULL
  tx.deleteRows('users', ['6', ['7']]);               // keys, not predicates
  await tx.commit();                                   // one atomic Commit RPC
});
```

Semantics:

- `insert` fails with `ALREADY_EXISTS` when the row exists.
- `update` fails with `NOT_FOUND` when the row does not exist.
- `upsert` (insertOrUpdate) inserts or updates.
- `replace` deletes the row, then inserts the new row. Columns not listed become `NULL`.
- `deleteRows` takes primary-key values, not predicates.

`Table` offers the same methods (`table.insert(rows)` and so on).
The `Table` methods each run a single-use read-write transaction and commit at once.
`MutationSet` plus `database.writeAtLeastOnce()` gives blind writes with
at-least-once semantics; replays can produce `ALREADY_EXISTS` errors.
`database.batchWriteAtLeastOnce()` sends multiple `MutationGroup`s without
atomicity across groups.

**Sharp edge:** mutations are invisible to reads inside the same transaction.
A SQL `SELECT` in the transaction does not see queued mutations.
DML statements do see earlier DML results.

Source: [mutation docs](https://docs.cloud.google.com/spanner/docs/modify-mutation-api),
[Table class reference](https://cloud.google.com/nodejs/docs/reference/spanner/latest/spanner/table).

## 5. DDL: Database.updateSchema and long-running operations

`Database.updateSchema(statements)` applies DDL.
It accepts one string, an array of strings, or an object with a `statements` array.
DDL cannot run through `database.run`.
The call returns a long-running `Operation` (GaxOperation).
The DDL keeps running on the server after the RPC returns.
Wait for completion with `operation.promise()`.

```ts
const [operation] = await database.updateSchema([
  `CREATE TABLE users (
     id STRING(36) NOT NULL,
     name STRING(MAX)
   ) PRIMARY KEY (id)`,
  'CREATE INDEX users_by_name ON users(name)',
]);
await operation.promise(); // wait for the LRO to finish
```

Notes for the adapter:

- Statements in one batch apply in order. A failed statement stops the batch.
  Earlier statements stay applied. The operation metadata reports per-statement progress.
- Spanner DDL has no transactional rollback.
- Statements must not end with semicolons in the array form.
- Index backfills can take minutes on large tables. Migrations must await the LRO.

Source: [updateSchema reference](https://cloud.google.com/nodejs/docs/reference/spanner/latest/spanner/database#_google_cloud_spanner_Database_updateSchema_member_1_),
[schema updates doc](https://docs.cloud.google.com/spanner/docs/schema-updates).

## 6. Session pool configuration

`instance.database(name, poolOptions)` accepts `SessionPoolOptions`
(`build/src/session-pool.d.ts`):

| Option | Default | Meaning |
| --- | --- | --- |
| `min` | 25 | Minimum sessions kept in the pool. |
| `max` | 100 | Maximum sessions. |
| `incStep` | 25 | Sessions created per growth step. |
| `maxIdle` | 1 | Maximum idle sessions kept. |
| `idlesAfter` | 10 | Minutes until a session counts as idle. |
| `keepAlive` | 30 | Minutes between pings of idle sessions. Must be under 1 hour. |
| `acquireTimeout` | Infinity | Milliseconds to wait for a session. |
| `fail` | false | Throw instead of waiting when the pool is empty. |
| `concurrency` | Infinity | Concurrent session-management requests. |

```ts
const database = instance.database('my-db', {
  min: 5,
  max: 50,
  acquireTimeout: 30_000,
  fail: false,
});
```

Notes:

- `writes`, `labels`, and `databaseRole` in pool options are deprecated.
- The pool emits `error` events; the adapter should listen for them.
- Leaked sessions (checked out, never released) raise `SessionLeakError` on
  `database.close()`. `getSnapshot` without `end()` leaks a session.
- Newer client versions can use multiplexed sessions instead of the pool
  (`build/src/multiplexed-session.d.ts`); this is controlled by Google via
  environment variables and is transparent to callers.

Source: [SessionPoolOptions reference](https://cloud.google.com/nodejs/docs/reference/spanner/latest/spanner/sessionpooloptions),
[sessions doc](https://docs.cloud.google.com/spanner/docs/sessions).

## 7. JavaScript value mapping

Decoding (from `build/src/codec.js`):

| Spanner type | JS value from `row.toJSON()` (default) | Wrapped value |
| --- | --- | --- |
| INT64 | `number`; **throws** `Integer <v> is out of bounds` when not a safe integer | `Int { value: string }` |
| FLOAT64 / FLOAT32 | `number` | `Float` / `Float32` |
| NUMERIC | `Numeric { value: string }` always; `valueOf()` returns a `Big` | `Numeric` |
| STRING | `string` | — |
| BOOL | `boolean` | — |
| BYTES | `Buffer` (decoded from base64) | — |
| TIMESTAMP | `PreciseDate` (extends `Date`, nanosecond precision) | — |
| DATE | `SpannerDate` (extends `Date`) | — |
| JSON | parsed object (`JSON.parse`) | — |
| ARRAY | JS array of decoded elements | — |
| STRUCT | `Struct` (array of fields) or POJO via `toJSON` | — |

Options that control the mapping:

- `row.toJSON({ wrapNumbers, wrapStructs, includeNameless })` per row.
- `json: true` on a request makes the client call `toJSON` for you.
- `jsonOptions: { wrapNumbers: true }` on a request applies to all rows.
- With `wrapNumbers: true`, INT64 arrives as `Int` with a string `value`. This
  is the safe path for values beyond `Number.MAX_SAFE_INTEGER`.

```ts
const [rows] = await database.run({
  sql: 'SELECT big_count FROM stats',
  json: true,
  jsonOptions: { wrapNumbers: true },
});
const raw: string = rows[0].big_count.value; // exact INT64 as string
```

Encoding helpers on the `Spanner` class: `Spanner.int()`, `Spanner.float()`,
`Spanner.float32()`, `Spanner.numeric()`, `Spanner.date()`, `Spanner.timestamp()`,
`Spanner.interval()`, plus PG-dialect wrappers (`pgNumeric`, `pgJsonb`, `pgOid`).

**Sharp edges for the adapter:**

- Default INT64 decoding throws on unsafe integers. The adapter must pick a
  mode: `number` (lossy, throws past 2^53−1), `string`, or `bigint` built from
  the wrapped string.
- A plain JS integer `number` encodes as INT64; a decimal encodes as FLOAT64.
  A FLOAT64 column bound to the value `1` mis-infers as INT64 without a hint
  or `Spanner.float(1)`.
- NUMERIC always decodes to a `Numeric` wrapper, never a plain number.
- TIMESTAMP decodes to `PreciseDate`; Spanner stores nanoseconds, JS `Date`
  keeps milliseconds.
- JSON columns need `Spanner.pgJsonb` only in PostgreSQL-dialect databases;
  GoogleSQL JSON accepts plain objects.

Source: [Data types doc](https://docs.cloud.google.com/spanner/docs/data-types),
[codec.ts](https://github.com/googleapis/nodejs-spanner/blob/main/src/codec.ts).

## 8. Emulator support

Set `SPANNER_EMULATOR_HOST` and the client redirects all traffic to the emulator.

```bash
gcloud emulators spanner start          # or:
docker run -p 9010:9010 -p 9020:9020 gcr.io/cloud-spanner-emulator/emulator
export SPANNER_EMULATOR_HOST=localhost:9010
```

```ts
// No credentials needed; the client detects the env var and uses an
// insecure channel with a fake projectId.
const spanner = new Spanner({ projectId: 'test-project' });
```

The value must not include a protocol prefix; `http://localhost:9010` throws
`GoogleError` (`build/src/index.js`).
The client disables TLS and auth automatically against the emulator.

Emulator limits:

- No TLS/HTTPS, no authentication, no IAM, no permissions, no roles.
- Read-write transactions and schema changes lock the whole database
  exclusively until they finish. Concurrent transaction tests behave
  differently from production; concurrent read-write transactions abort
  each other aggressively.
- No query plans: `PLAN` and `PROFILE` query modes are unsupported.
- No `ANALYZE` statement.
- Partitioned DML statements are not validated for partitionability.
- No audit logging or monitoring integration.
- Data is in-memory only; state is lost on restart.
- Historically lags production on new features (for example, newer DDL or
  dialect features may land late).

Source: [emulator doc](https://docs.cloud.google.com/spanner/docs/emulator),
[cloud-spanner-emulator README](https://github.com/GoogleCloudPlatform/cloud-spanner-emulator#features-and-limitations).

## Summary of sharp edges for the Drizzle adapter

1. Null parameters need explicit type hints. The adapter must derive `types`
   from the Drizzle schema for every nullable binding and empty array.
2. DML must run inside `runTransactionAsync`; `database.run` is read-only.
3. Transaction callbacks re-execute on `ABORTED`; user code must be idempotent.
4. `maxStaleness` / `minReadTimestamp` work only on single-use reads.
5. Mutations are not visible to reads in the same transaction.
6. INT64 decoding throws on unsafe integers unless numbers are wrapped.
7. DDL is a long-running operation with no rollback; migrations must await it.
8. Snapshots must call `end()` or the session pool leaks.
9. The emulator serializes read-write transactions; concurrency tests lie.
