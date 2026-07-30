import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The repo root is the drizzle-spanner package itself, so the kit's
    // imports of it resolve to source here (published installs resolve
    // through node_modules).
    alias: {
      'drizzle-spanner/migrator': fileURLToPath(new URL('./src/migrator.ts', import.meta.url)),
      'drizzle-spanner': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // Integration tests start one Spanner emulator container per worker and
    // the emulator serializes read-write transactions, so keep file
    // parallelism bounded by worker count (testcontainers scope is per worker).
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
