/**
 * CodeConClave backend — dedicated config for the wall-clock performance smoke.
 *
 * Why this is separate from vitest.config.ts
 * ------------------------------------------
 * perf-17 asserts on elapsed wall-clock time (Date.now deltas against
 * 2000ms / 1000ms / 50ms budgets). Measured on the development host:
 *
 *   ~1000ms  run alone on an idle machine
 *   ~3800ms  while any other suite is executing
 *
 * That ~3.8x swing comes from CPU contention, not from the code under test.
 * Vitest 3.2 runs sibling *projects* concurrently and exposes no inter-project
 * ordering, so simply giving perf-17 its own project does not help — it would
 * still share the runner with the rest of the suite.
 *
 * Running it as a dedicated pipeline job (`npm run test:perf`) is the only
 * arrangement that gives it an uncontended machine. It is therefore excluded
 * from vitest.config.ts and included here.
 *
 * This does not weaken the test: the budgets, the measured values and the
 * assertions are unchanged. Nothing is skipped, retried or loosened — the
 * measurement is simply taken on a runner that is not doing anything else.
 *
 * Cryptographic parameters, timeouts and every other suite are untouched.
 */
import { defineConfig } from 'vitest/config';

import { ENV } from './vitest.env.js';

export default defineConfig({
  test: {
    name: 'perf',
    environment: 'node',
    // Unchanged from vitest.config.ts. The measured durations here are ~1s
    // against a 15s deadline; the failure mode being fixed is contention, not
    // a need for a longer deadline.
    testTimeout: 15000,
    pool: 'forks',
    // This job exists to give the measurement a quiet machine. Parallelism and
    // multiple workers would reintroduce exactly the contention it avoids.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    include: ['src/foundation/perf-17.test.ts'],
    env: { ...ENV },
  },
});
