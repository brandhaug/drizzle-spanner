import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests start one Spanner emulator container per worker and
    // the emulator serializes read-write transactions, so keep file
    // parallelism bounded by worker count (testcontainers scope is per worker).
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
