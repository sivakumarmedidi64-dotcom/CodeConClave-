/**
 * Agent Sai Srinivasa Athreya — 24/7 auto-refresh, now REGION-AWARE.
 *
 * The watchdog (or a standalone regional detective) calls refreshSai() often,
 * but Agent Sai only re-pulls a few targets each time, and only ones that have
 * gone stale — so popular data stays warm WITHOUT hammering the public APIs.
 *
 * Each detective warms a BASE set (universally popular) PLUS the set for its own
 * region (SAI_REGION): India Sai keeps Indian data warm, US Sai keeps US data
 * warm, and so on. They all write into the one shared case file, so a user
 * anywhere gets the full, warm picture. Failures are logged and skipped — never
 * fatal, never faked. Keyed targets (mandi prices, NASA…) warm only where their
 * key is set; elsewhere they skip quietly.
 */
import { logger } from '../../shared/logger.js';
import { env } from '../../config/env.js';
import { runConnector } from './connectors.js';
import './caseFile.js'; // side-effect: wires the Postgres shared case file (L2) for the server/watchdog/detective

type Target = [sourceId: string, query: string, minIntervalMs: number];

const MIN = 60_000;
const HR = 3_600_000;

/** Warmed by every detective — the universally popular answers. */
const BASE_TARGETS: Target[] = [
  ['usgs-earthquakes', '', 10 * MIN],
  ['hacker-news-api', '', 15 * MIN],
  ['coingecko', 'bitcoin ethereum', 5 * MIN],
  ['nasa-eonet', '', 30 * MIN],
  ['satellite-position', '', 10 * MIN],
  ['github', 'ai', 60 * MIN],
  ['cisa-kev', '', 6 * HR],
  ['frankfurter', 'USD INR', 60 * MIN],
];

/** Extra targets each regional detective keeps warm (its local "beat"). */
const REGION_TARGETS: Record<string, Target[]> = {
  india: [
    ['aqicn', 'delhi', 20 * MIN],
    ['aqicn', 'mumbai', 20 * MIN],
    ['aqicn', 'hyderabad', 20 * MIN],
    ['data-gov-in', 'Tomato', 60 * MIN],
    ['data-gov-in', 'Onion', 60 * MIN],
    ['data-gov-in', 'Potato', 60 * MIN],
    ['open-meteo', 'Mumbai', 30 * MIN],
    ['open-meteo-air-quality', 'Delhi', 30 * MIN],
    ['wikipedia-pageviews', 'India', 6 * HR],
    ['world-bank-api', 'IN:NY.GDP.MKTP.CD', 12 * HR],
  ],
  us: [
    ['nasa', '', 6 * HR],
    ['fred-alfred', 'inflation', 60 * MIN],
    ['us-treasury', '', 12 * HR],
    ['us-weather-alerts', 'CA', 30 * MIN],
    ['open-meteo', 'New York', 30 * MIN],
    ['sec-edgar', 'Apple', 6 * HR],
  ],
  singapore: [
    ['open-meteo', 'Singapore', 30 * MIN],
    ['open-meteo-air-quality', 'Singapore', 30 * MIN],
    ['gdelt', 'asia', 15 * MIN],
    ['open-meteo', 'Jakarta', 60 * MIN],
  ],
  australia: [
    ['open-meteo', 'Sydney', 30 * MIN],
    ['open-meteo-air-quality', 'Sydney', 30 * MIN],
    ['open-meteo-marine', 'Sydney', 60 * MIN],
    ['nager-holidays', 'AU', 24 * HR],
  ],
  // One all-in-one detective (the default) keeps a bit of every region warm.
  global: [
    ['gdelt', 'india', 15 * MIN],
    ['aqicn', 'delhi', 20 * MIN],
    ['data-gov-in', 'Tomato', 60 * MIN],
    ['open-meteo', 'Mumbai', 30 * MIN],
    ['nasa', '', 6 * HR],
  ],
};

/** The targets this detective (its SAI_REGION) is responsible for keeping warm. */
function targetsForRegion(region: string): Target[] {
  return [...BASE_TARGETS, ...(REGION_TARGETS[region] ?? REGION_TARGETS.global ?? [])];
}

const lastWarmed = new Map<string, number>();
/** Pulls per sweep — small, so the full set spreads over a few minutes. */
const MAX_PER_SWEEP = 4;

/** Warm a few stale targets for this detective's region. Returns how many were re-pulled. */
export async function refreshSai(now: number = Date.now()): Promise<number> {
  const targets = targetsForRegion(env.SAI_REGION);
  const due = targets.filter(([id, query, interval]) => now - (lastWarmed.get(`${id}\n${query}`) ?? 0) >= interval);
  if (due.length === 0) return 0;
  // Oldest-warmed first, then take a small batch this sweep.
  due.sort((a, b) => (lastWarmed.get(`${a[0]}\n${a[1]}`) ?? 0) - (lastWarmed.get(`${b[0]}\n${b[1]}`) ?? 0));
  let done = 0;
  for (const [id, query] of due.slice(0, MAX_PER_SWEEP)) {
    lastWarmed.set(`${id}\n${query}`, now); // mark first, so a slow one doesn't retry next tick
    try {
      await runConnector(id, query, true); // force = fetch fresh + refill the shared case file
      done += 1;
    } catch (err) {
      logger.warn('sai.refresh_skip', { source: id, region: env.SAI_REGION, reason: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    }
  }
  return done;
}
