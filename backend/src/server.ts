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
import { env } from './config/env.js';
import { logger } from './shared/logger.js';

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

  const app = createApp();
  const server = createServer(app);
  attachAgentHub(server);

  const stopWorker = startWorker();
  const stopWatchdog = startWatchdog();

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

  server.listen(env.PORT, () => {
    logger.info('CodeConClave server listening', {
      port: env.PORT,
      url: env.APP_URL,
      provider: env.STORAGE_PROVIDER,
    });
  });

const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    // Abort in-flight SSE chat streams (they send a terminal frame or drop
    // cleanly), then close WebSocket resources, then drain in-flight worker
    // executions (bounded inside the worker) before the pool is ended �?" ending
    // the pool mid-drain would fail live queries.
    abortActiveStreams();
    agentWs().close();
    browserRelay().close();
    stopWatchdog();
    server.close(() => undefined);
    void stopWorker().then(async () => {
      await pool.end();
      process.exit(0);
    });
    // Bounded backstop for orchestrators that expect a prompt exit.
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('server fatal', { err: err instanceof Error ? err.message : err });
  process.exit(1);
});
