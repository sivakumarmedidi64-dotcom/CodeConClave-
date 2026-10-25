/**
 * Agent Sai Srinivasa Athreya — 24/7 auto-refresh.
 *
 * The watchdog calls refreshSai() often (every ~15s), but Agent Sai only
 * actually re-pulls a few targets each time, and only ones that have gone
 * stale — so popular data stays warm in the cache WITHOUT hammering the public
 * APIs (rate-limit friendly). Each real pull refills the cache, so by the time
 * a user asks, the answer is already waiting (instant). Failures are logged and
 * skipped — never fatal, never faked.
 */
import { logger } from '../../shared/logger.js';
import { runConnector } from './connectors.js';

/** The popular queries Agent Sai keeps warm. [sourceId, query, minIntervalMs]. */
const WARM_TARGETS: [string, string, number][] = [
  ['usgs-earthquakes', '', 10 * 60_000],
  ['hacker-news-api', '', 15 * 60_000],
  ['nasa', '', 6 * 3_600_000],
  ['opensky-network', '', 3 * 60_000],
  ['cisa-kev', '', 6 * 3_600_000],
  ['coingecko', 'bitcoin ethereum', 5 * 60_000],
  ['gdelt', 'india', 15 * 60_000],
  ['aqicn', 'delhi', 20 * 60_000],
  ['aqicn', 'hyderabad', 20 * 60_000],
  ['aqicn', 'mumbai', 20 * 60_000],
  ['data-gov-in', 'Tomato', 60 * 60_000],
  ['data-gov-in', 'Onion', 60 * 60_000],
  ['data-gov-in', 'Potato', 60 * 60_000],
  ['github', 'ai', 60 * 60_000],
  ['npm-pypi-stats', 'react', 60 * 60_000],
  ['world-bank-api', 'IN:NY.GDP.MKTP.CD', 12 * 3_600_000],
  ['fred-alfred', 'inflation', 60 * 60_000],
  ['wikipedia-pageviews', 'India', 6 * 3_600_000],
  ['endoflife-date', 'nodejs', 12 * 3_600_000],
];

const lastWarmed = new Map<string, number>();
/** Pulls per sweep — small, so the full set spreads over a few minutes. */
const MAX_PER_SWEEP = 4;

/** Warm a few stale targets. Returns how many were actually re-pulled. */
export async function refreshSai(now: number = Date.now()): Promise<number> {
  const due = WARM_TARGETS.filter(([id, query, interval]) => now - (lastWarmed.get(`${id}\n${query}`) ?? 0) >= interval);
  if (due.length === 0) return 0;
  // Oldest-warmed first, then take a small batch this sweep.
  due.sort((a, b) => (lastWarmed.get(`${a[0]}\n${a[1]}`) ?? 0) - (lastWarmed.get(`${b[0]}\n${b[1]}`) ?? 0));
  let done = 0;
  for (const [id, query] of due.slice(0, MAX_PER_SWEEP)) {
    lastWarmed.set(`${id}\n${query}`, now); // mark first, so a slow one doesn't retry next tick
    try {
      await runConnector(id, query, true); // force = fetch fresh + refill cache
      done += 1;
    } catch (err) {
      logger.warn('sai.refresh_skip', { source: id, reason: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    }
  }
  return done;
}
