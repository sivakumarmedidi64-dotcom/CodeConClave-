/**
 * Agent Sai Srinivasa Athreya — the shared CASE FILE (cross-region sharing).
 *
 * Each regional detective keeps a fast in-memory cache (L1, see connectors.ts),
 * but they SHARE through this one database table (L2 — the `sai_cache` table
 * from migration 0163). So when the US detective catches something, the India
 * detective gets it instantly from the shared case file instead of re-pulling.
 *
 * Everything here is BEST-EFFORT and HONEST:
 *   - if the database is down or slow, every call fails quietly and the caller
 *     falls back to a real live fetch — Agent Sai never blocks and never fakes;
 *   - reads are bounded by a short timeout so a sick database can never stall a
 *     user's answer;
 *   - writes are fire-and-forget (the user never waits for the shared write).
 */
import { pool } from '../../shared/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { setSaiCaseFile, setSaiEdgeFallback } from './connectors.js';
import type { SaiEvidence } from './connectors.js';

/** Which detective this process is. Set per deployment, e.g. SAI_REGION=india. */
export const SAI_REGION: string = env.SAI_REGION;

/** A fresh entry from the shared case file, mapped to the same shape as L1. */
export interface CaseFileEntry {
  evidence: SaiEvidence;
  storedAt: number; // ms epoch
  expires: number; // ms epoch
}

/** Short bound so an unreachable/slow database never stalls a user's answer. */
const READ_TIMEOUT_MS = 2_000;

interface Row {
  evidence: SaiEvidence;
  stored_at: Date;
  expires_at: Date;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('sai_case_file_timeout')), ms)),
  ]);
}

/**
 * Read one answer from the shared case file. Returns null on a miss, on any
 * database error, or on timeout — the caller then does a real live fetch.
 * Expired rows are treated as a miss (the caller re-pulls and overwrites).
 */
export async function readCaseFile(key: string): Promise<CaseFileEntry | null> {
  try {
    const result = await withTimeout(
      pool.query<Row>('SELECT evidence, stored_at, expires_at FROM sai_cache WHERE cache_key = $1', [key]),
      READ_TIMEOUT_MS,
    );
    const row = result.rows[0];
    if (!row) return null;
    const expires = new Date(row.expires_at).getTime();
    if (Date.now() >= expires) return null; // stale → treat as miss
    return { evidence: row.evidence, storedAt: new Date(row.stored_at).getTime(), expires };
  } catch (err) {
    // Quiet by design: a missing/slow shared file must never break an answer.
    logger.warn('sai.case_file_read_skip', { reason: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    return null;
  }
}

/**
 * Write (upsert) one caught answer into the shared case file, tagged with this
 * detective's region. Fire-and-forget: the user never waits for it, and a
 * database error is logged and swallowed — the live answer still returns.
 */
export async function writeCaseFile(
  key: string,
  sourceId: string,
  query: string,
  evidence: SaiEvidence,
  storedAtMs: number,
  expiresMs: number,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO sai_cache (cache_key, source_id, query, evidence, region, stored_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
       ON CONFLICT (cache_key) DO UPDATE
         SET evidence = EXCLUDED.evidence,
             region = EXCLUDED.region,
             stored_at = EXCLUDED.stored_at,
             expires_at = EXCLUDED.expires_at`,
      [key, sourceId, query, JSON.stringify(evidence), SAI_REGION, storedAtMs / 1000, expiresMs / 1000],
    );
  } catch (err) {
    logger.warn('sai.case_file_write_skip', { source: sourceId, reason: err instanceof Error ? err.message.slice(0, 120) : 'error' });
  }
}

/** How many fresh (non-expired) answers are in the shared case file, or 0 if unavailable. */
export async function caseFileCount(): Promise<number> {
  try {
    const result = await withTimeout(
      pool.query<{ n: string | number }>('SELECT count(*)::int AS n FROM sai_cache WHERE expires_at > now()'),
      READ_TIMEOUT_MS,
    );
    return Number(result.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Delete expired rows from the shared case file. Returns how many were removed. */
export async function sweepCaseFile(): Promise<number> {
  try {
    const result = await pool.query('DELETE FROM sai_cache WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn('sai.case_file_sweep_skip', { reason: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    return 0;
  }
}

// Wire the Postgres-backed shared case file into the connectors (L2). Importing
// this module (server, watchdog, detective) is enough to turn sharing on; a
// Cloudflare Worker instead wires a Neon-serverless one and never loads this file.
setSaiCaseFile({
  read: readCaseFile,
  write: (key, sourceId, query, evidence, storedAtMs, expiresMs) => {
    void writeCaseFile(key, sourceId, query, evidence, storedAtMs, expiresMs);
  },
});

// L3 edge fallback: when THIS host's own fetch to a public API is throttled
// (Render's shared IP gets HTTP 429 from some free APIs), retry the same pull
// through the Cloudflare edge worker. Backend only — the Worker never imports
// this file, so it never calls itself.
setSaiEdgeFallback(process.env.SAI_EDGE_URL?.trim() || 'https://codeconclave-007.sivakumarmedidi64.workers.dev');
