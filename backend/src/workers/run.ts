/**
 * CodeConClave — standalone process: task worker + watchdog (npm run worker).
 */
import { startWorker } from './task-worker.js';
import { startWatchdog } from './watchdog.js';
import { registerCoreTools } from '../modules/execution/tools.js';
import { registerPaymentTools } from '../modules/payments/tools.js';
import { registerPlugins } from '../modules/plugins/index.js';
import { initCache } from '../shared/cache.js';
import { logger } from '../shared/logger.js';

async function main(): Promise<void> {
  await initCache();
  registerCoreTools();
  registerPaymentTools();
  registerPlugins();
  const stopWorker = startWorker();
  const stopWatchdog = startWatchdog();
  logger.info('worker process ready');
  const shutdown = async (signal: string) => {
    logger.info('worker shutting down', { signal });
    // Phase 16: graceful shutdown — stop claiming, drain in-flight executions
    // (bounded), then stop the watchdog and exit.
    await stopWorker();
    stopWatchdog();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('worker fatal', { err: err instanceof Error ? err.message : err });
  process.exit(1);
});