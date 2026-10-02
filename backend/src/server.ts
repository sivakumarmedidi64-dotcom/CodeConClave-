/**
 * CodeConClave — HTTP server entrypoint (npm run dev / npm start).
 * Fails fast when the database is unreachable or migrations are pending:
 * serving an unmigrated schema would silently corrupt state.
 * Runs the in-process task worker + watchdog; use `npm run worker` for a
 * standalone worker process.
 */
import { createServer } from 'node:http';
import { createApp, attachAgentHub, ensureTools } from './app.js';
import { initCache } from './shared/cache.js';
import { ping, pool } from './shared/db.js';
import { migrateStatus } from './database/migrate.js';
import { registerPaymentTools } from './modules/payments/tools.js';
import { registerPlugins } from './modules/plugins/index.js';
import { startWorker } from './workers/task-worker.js';
import { startWatchdog } from './workers/watchdog.js';
import { agentWs } from './modules/agent/ws.js';
import { browserRelay } from './modules/agent/browser.js';
import { abortActiveStreams } from './modules/conversations/routes.js';
import { expireStaleSessions } from './modules/auth/service.js';
import { sweepDigests } from './modules/digests/service.js';
import { initializeSentry } from './observability/sentry.js';
import { initStorage } from './integrations/storage.js';
import { env } from './config/env.js';
import { logger } from './shared/logger.js';
import { cache } from './shared/cache.js';

async function main(): Promise<void> {
  initializeSentry();
  await initCache();

  const dbOk = await ping();
  if (!dbOk) {
    logger.error('database unreachable — refusing to start (DATABASE_URL)');
    process.exit(1);
  }

  const migrationStatus = await migrateStatus();
  const pending = migrationStatus.filter((m) => !m.applied).map((m) => m.file);
  if (pending.length > 0) {
    logger.error('pending migrations — run `npm run db:migrate` first', { pending });
    process.exit(1);
  }
  logger.info('database ready', { migrations: migrationStatus.length });

  await initStorage();

  registerPaymentTools();
  registerPlugins();
  ensureTools();

  // Seed system workflow recipes (idempotent; best-effort — rules still work without them).
  try {
    const { seedSystemRecipes } = await import('./modules/automations/recipes.js');
    await seedSystemRecipes();
  } catch (err) {
    logger.warn('recipe seeding failed', { error: (err as Error).message });
  }

  // Provision the payment-link pool catalogue from deployment config
  // (PAYMENT_POOL_LINKS). Idempotent; preserves live RESERVED links; INR-only.
  // Fail-loud: explicit config that cannot yield a usable pool means every
  // checkout would 503 (ALL_LINKS_BUSY_TRY_AGAIN) — we refuse to boot that way.
  try {
    const { seedPaymentPool, assertPoolUsable } = await import('./modules/payments/pool/seeder.js');
    await assertPoolUsable(await seedPaymentPool());
  } catch (err) {
    logger.error('payment-link pool provisioning failed — refusing to start', { error: (err as Error).message });
    process.exit(1);
  }

  const app = createApp();
  const server = createServer(app);
  attachAgentHub(server);

  const stopWorker = startWorker();
  const stopWatchdog = startWatchdog();
  const stopAutoApprovalSweep = await import('./modules/payments/autoapproval/service.js').then((m) => m.startAutoApprovalSweep(1000));

  // Session-expiry retention sweep (every 6 hours; never blocks shutdown).
  const sessionSweep = setInterval(() => {
    expireStaleSessions()
      .then((n) => {
        if (n > 0) logger.info('session expiry sweep', { expired: n });
      })
      .catch((err) => logger.warn('session expiry sweep failed', { error: (err as Error).message }));
  }, 6 * 60 * 60 * 1000);
  sessionSweep.unref();

  // Digest scheduler (every 5 minutes): delivers due daily/weekly digests in
  // each user's local timezone; idempotent per period.
  const digestSweep = setInterval(() => {
    sweepDigests()
      .then((n) => {
        if (n > 0) logger.info('digest sweep', { delivered: n });
      })
      .catch((err) => logger.warn('digest sweep failed', { error: (err as Error).message }));
  }, 5 * 60 * 1000);
  digestSweep.unref();

  // IMAP payment auto-unlock sweep (no-API / no-webhook rail). Idle unless
  // PAYMENT_IMAP_UNLOCK_ENABLED=true with mailbox credentials configured.
  const { startImapUnlockLoop, stopImapUnlockLoop } = await import('./modules/payments/imap-unlock/service.js');
  startImapUnlockLoop();

  server.listen(env.PORT, () => {
    logger.info('CodeConClave server listening', {
      port: env.PORT,
      url: env.APP_URL,
      provider: env.STORAGE_PROVIDER,
    });
    // TEST-ONLY payment bypass visibility: log that the allowlist is active
    // WITHOUT logging any user ID. Empty (default) = fully disabled.
    if (env.PAYMENT_TEST_USER_IDS.trim()) {
      logger.warn('PAYMENT_TEST_USER_IDS is set: listed test accounts bypass payment (Team workspace, no payment rows written)');
    }
  });

const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    stopImapUnlockLoop();
    stopAutoApprovalSweep();
    abortActiveStreams();
    agentWs().close();
    browserRelay().close();
    stopWatchdog();
    server.close(() => {
      logger.info('HTTP server closed');
    });
    void stopWorker().then(async () => {
      await cache.health(); // close Redis connection
      await pool.end();
      logger.info('Database pool closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('server fatal', { err: err instanceof Error ? err.message : err });
  process.exit(1);
});
