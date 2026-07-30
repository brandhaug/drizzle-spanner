# basic-crud

Schema definition, `drizzle-spanner-kit migrate`, CRUD with `.returning()`,
and a read-write transaction — all against the Spanner emulator.

```bash
# from the repository root
npm ci && npm run build && npm run build -w drizzle-spanner-kit
npm run emulator:up

cd examples/basic-crud
npm install
npm start
```

`npm start` bootstraps the emulator instance/database, applies the checked-in
migration in [drizzle/](drizzle/) (produced by `drizzle-spanner-kit
generate`), and runs [src/main.ts](src/main.ts).

This example depends on the packages via `file:` links so it runs from the
repository. In your own project, install `drizzle-spanner`,
`drizzle-spanner-kit` and `@google-cloud/spanner` from npm.
