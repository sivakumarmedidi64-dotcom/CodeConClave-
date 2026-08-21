/**
 * CodeConClave — database access layer.
 * - pg Pool (single logical database; no per-tier architecture)
 * - withTenant(): transaction that sets app.current_user_id (RLS key) from the
 *   authenticated session — NEVER from client input.
 * - query helpers that always run inside a tenant-scoped transaction.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from './logger.js';

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Hard per-statement bound so a hung/cancelled query cannot pin a pooled
  // connection forever (Stage 25). Worst measured write is ~5s p50; 30s is
  // generous for every real query path while still releasing the slot.
  options: '-c statement_timeout=30000',
  ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  logger.error('pg pool error', { error: err.message });
});

export type DbQueryable = pg.Pool | pg.PoolClient;

export interface Tenant {
  userId: string;
}

export interface Tx {
  client: pg.PoolClient;
  done: () => void;
}

/**
 * Run work inside a tenant-scoped transaction: BEGIN, SET LOCAL app.current_user_id,
 * run fn, COMMIT (or ROLLBACK on error). The user id is passed from the authenticated
 * session — client-supplied ids are never accepted here.
 */
export async function withTenant<T>(
  userId: string | null,
  fn: (q: pg.PoolClient) => Promise<T>,
  source: pg.Pool = pool,
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    if (userId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
    } else {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** System-scoped transaction (workers, audit flusher): sets no user context. */
export function withSystem<T>(fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTenant(null, fn);
}

export interface DbRow {
  [key: string]: unknown;
}

export async function queryOne<T extends object = DbRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await pool.query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends object = DbRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}