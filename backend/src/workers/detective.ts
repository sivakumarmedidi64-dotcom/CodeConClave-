/**
 * Agent Sai Srinivasa Athreya — a regional DETECTIVE (standalone, lightweight).
 *
 * This is the small process you deploy once per region to "complete the 4
 * countries". It does NOT run the full CodeConClave app — only:
 *   1. the region's 24/7 data-warming loop (fills the shared case file), and
 *   2. a tiny /healthz endpoint (for the host's health check + a cron pinger).
 *
 * Deploy one per region and set just two things:
 *   SAI_REGION   = india | us | singapore | australia   (who this detective is)
 *   DATABASE_URL = the SAME database as your main app    (so they share one case file)
 * Everything else uses safe defaults. Keep it awake with a free pinger
 * (e.g. cron-job.org) hitting /healthz every ~10 minutes if the host sleeps.
 *
 * Because every detective writes into the one shared case file, a pull by this
 * region is instantly reusable by every other region and by the main app.
 */
import { createServer } from 'node:http';
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';

const SWEEP_MS = 20_000;

async function tick(): Promise<void> {
  try {
    const { refreshSai } = await import('../modules/sai/refresh.js');
    const warmed = await refreshSai();
    if (warmed > 0) logger.info('detective.warmed', { region: env.SAI_REGION, warmed });
  } catch (err) {
    logger.warn('detective.tick_failed', { region: env.SAI_REGION, error: err instanceof Error ? err.message : 'error' });
  }
}

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'Agent Sai Srinivasa Athreya', region: env.SAI_REGION, time: new Date().toISOString() }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});

server.listen(env.PORT, () => {
  logger.info('detective.started', { region: env.SAI_REGION, port: env.PORT });
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_MS);
  const shutdown = (): void => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});
