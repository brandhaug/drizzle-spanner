// fallow-ignore-file unused-file
// Loaded dynamically by drizzle-spanner-kit via the example's `npm start`.
import { defineConfig } from 'drizzle-spanner-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  database: {
    project: process.env.SPANNER_PROJECT_ID ?? 'example-project',
    instance: process.env.SPANNER_INSTANCE_ID ?? 'example-instance',
    database: process.env.SPANNER_DATABASE_ID ?? 'interleaved-rqb',
    emulatorHost: process.env.SPANNER_EMULATOR_HOST ?? 'localhost:9010'
  }
})
