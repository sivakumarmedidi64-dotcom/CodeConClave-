/**
 * CodeConClave backend — vitest configuration.
 * Pure unit tests never touch a real database; the DATABASE_URL here only
 * satisfies the env schema for import-time validation. DB-dependent suites
 * are gated at runtime on a reachable DATABASE_URL and skipped otherwise.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Full-suite runs (60+ files in one process) hit CPU contention that
    // occasionally exceeds the 5s default; 15s keeps the deadline realistic
    // without weakening any assertion.
    testTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/codeconclave_test',
      QUEUE_PROVIDER: 'memory',
      STORAGE_PROVIDER: 'memory',
      LOG_LEVEL: 'error',
    },
  },
});