# interleaved-rqb

Interleaved parent/child tables (singers/albums), relational queries via
`ARRAY(SELECT AS STRUCT)`, buffered-mutation writes, and a stale read —
against the Spanner emulator, with the schema applied by
`drizzle-spanner-kit push`.

```bash
# from the repository root
npm ci && npm run build && npm run build -w drizzle-spanner-kit
npm run emulator:up

cd examples/interleaved-rqb
npm install
npm start
```

This example depends on the packages via `file:` links so it runs from the
repository. In your own project, install `drizzle-spanner`,
`drizzle-spanner-kit` and `@google-cloud/spanner` from npm.
