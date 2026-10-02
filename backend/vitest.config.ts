/**
 * CodeConClave backend — vitest configuration.
 * Pure unit tests never touch a real database; the DATABASE_URL here only
 * satisfies the env schema for import-time validation. DB-dependent suites
 * are gated at runtime on a reachable DATABASE_URL and skipped otherwise.
 *
 * Why the suite is split into two projects
 * ----------------------------------------
 * `shared/crypto.ts` derives every password/keyword/key hash with
 * scrypt at N=65536 (~1.7s of deliberately expensive CPU per call, see the
 * DoS-amplifier note in crypto.ts). The authentication suites exercise that
 * helper dozens of times, so their wall-clock cost is CPU-bound rather than
 * I/O-bound.
 *
 * When several of those files land on different worker processes at once,
 * every one of them slows down proportionally — the failure mode observed on
 * a loaded CI machine was `confirmMfa` needing 11.8s against a 15s deadline,
 * i.e. passing locally and failing in the pipeline with no code change.
 *
 * The fix is scheduling, not leniency:
 *   - project `unit`  — everything else (226 files), keeping normal parallelism.
 *   - project `serial` — only the 9 suites in SERIAL_SUITES, pinned to a single
 *     worker so each hash gets a full core instead of competing with siblings.
 *
 * perf-17 asserts on `Date.now()` deltas (2000ms/1000ms/50ms budgets) and
 * degrades for the same CPU-contention reason, but it needs a completely idle
 * machine rather than just fewer siblings — it measures ~1000ms alone and
 * ~3800ms under any concurrent load. Pinning it to one worker inside this
 * suite does not help, because Vitest runs sibling projects concurrently. It
 * therefore runs as its own pipeline job via `npm run test:perf`; see
 * vitest.perf.config.ts.
 *
 * Cryptographic parameters are untouched (N stays 65536 in both projects and in
 * production code); no test is skipped or retried; no assertion or threshold
 * changes. These are separate projects precisely so this protection does not
 * serialize the other 226 test files.
 */
import { defineConfig } from 'vitest/config';

/**
 * Test files that need an uncontended machine, and which therefore run in the
 * `serial` project (one worker, no sibling workers) — and in CI, on a dedicated
 * runner so the `unit` project's four workers cannot starve them.
 *
 * Criterion for membership: the suite performs heavy CPU work of one of two
 * kinds. Widen the list only for a file that measurably hits this, and record
 * the idle measurement in the comment; importing an auth module is cheap and
 * is NOT on its own a reason to be here.
 *
 *   a) scrypt cost centre (N=65536, ~1.7s per hash on the dev host). Measured
 *      on an idle machine against the 15000ms deadline:
 *        auth.test.ts                  confirmMfa        ~6.3s
 *        integration-17.test.ts        signup…MFA login   ~7.1s
 *        security-15.test.ts           confirmMfa rotate  ~5.2s
 *      Only ~2x headroom, so ordinary parallel contention is enough to fail.
 *
 *   b) full app-graph assembly — importing app.js and creating a server forces
 *      a cold transform of the entire graph:
 *        gmail-claim.test.ts           beforeAll hook     blew its 120s budget
 *                                      under parallel load.
 */
const SERIAL_SUITES = [
  // (a) scrypt cost centre (N=65536, ~1.7s per hash)
  'src/foundation/auth.test.ts',
  'src/foundation/identity.test.ts',
  'src/foundation/otp.test.ts',
  'src/foundation/pairing.test.ts',
  'src/foundation/founder-access.test.ts',
  'src/foundation/integration-17.test.ts',
  'src/foundation/security-15.test.ts',
  'src/shared/crypto.test.ts',
  // (b) full app-graph assembly
  'src/modules/payments/gmail-claim.test.ts',
];

/**
 * perf-17 asserts on wall-clock time (Date.now deltas against 2000/1000/50ms
 * budgets), so it needs a machine that is genuinely idle, not merely one with
 * fewer sibling workers. Measured on this host: ~1000ms when run alone, ~3800ms
 * while any other suite is in flight — a 3.8x swing that no worker-count tuning
 * can remove, because Vitest 3.2 runs sibling *projects* concurrently and offers
 * no inter-project ordering.
 *
 * So it is excluded here and run as its own dedicated pipeline job
 * (`npm run test:perf`), which is the only place it gets an uncontended runner.
 * It is still executed on every pipeline — not skipped — just not sharing a
 * runner with 230 other files.
 */
const PERF_SUITE = 'src/foundation/perf-17.test.ts';

import { ENV } from './vitest.env.js';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // 15s deadline keeps real-path integrations realistic (assertions unchanged).
          testTimeout: 15000,
          // Root-cause for full-suite CPU contention: vitest's default parallelism
          // forks one worker per available processor (12 here), each cold-transforming the
          // full app graph (~75 imports) and starving the integration/perf suites
          // (gmail-claim boots the assembled app 3x; perf-17 measures real paths).
          // Capping the fork pool bounds concurrent cold transforms so shared CPU is
          // never exhausted; assertions and timeouts are unchanged and the pool stays
          // message-packaged (no serialization of the whole suite).
          pool: 'forks',
          maxWorkers: 4,
          minWorkers: 1,
          include: ['src/**/*.test.ts'],
          exclude: [...SERIAL_SUITES, PERF_SUITE],
          env: { ...ENV },
        },
      },
      {
        test: {
          name: 'serial',
          environment: 'node',
          testTimeout: 15000,
          // Single worker: each scrypt hash in the cost centre (N=65536, ~1.7s per
          // call) gets a full core instead of competing with sibling workers.
          // Same timeout and same assertions as `unit` — only the scheduling
          // differs.
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          include: SERIAL_SUITES,
          env: { ...ENV },
        },
      },
    ],
  },
});
