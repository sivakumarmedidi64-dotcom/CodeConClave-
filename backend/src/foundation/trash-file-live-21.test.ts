/**
 * CodeConClave — Stage 21 live regression: trash file restore/purge SQL.
 *
 * The tenant scope constant references the files table with the `f` alias
 * (f.owner_id / f.project_id). restoreItem and purgeItem previously ran
 * `SELECT project_id FROM files WHERE ... AND (f.owner_id = $1 ...)` — no
 * alias on the FROM clause — so PostgreSQL rejected every file restore/purge
 * with `missing FROM-clause entry for table "f"`, surfacing as an honest
 * HTTP 500 (internal_error) on POST /api/v1/trash/restore/file/:id.
 *
 * These tests run the REAL service against the REAL configured database:
 * a nonexistent file id proves the query PARSES (before the fix it throws a
 * raw pg error; after the fix it resolves to a clean not_found AppError).
 * If the database is unreachable the describe block is skipped — never a
 * fake pass.
 *
 * The reachability probe runs at module load (top-level await) because
 * describe.skipIf is evaluated at collection time, before any beforeAll.
 */
import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { env } from '../config/env.js';
import { restoreItem, purgeItem } from '../modules/trash/service.js';
import { AppError } from '../shared/errors.js';

const probe = new pg.Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 6000,
  ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let live = false;
let probeError = '';
try {
  await probe.connect();
  await probe.query('SELECT 1');
  live = true;
} catch (err) {
  probeError = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[trash-live] DB probe failed: ${probeError}\n`);
} finally {
  await probe.end().catch(() => {});
}

it.skipIf(live)('live DB probe failed — tests skipped honestly (non-secret reason)', () => {
  // Runs only when the database is unreachable: report why without secrets.
  expect(probeError).not.toContain(process.env.DATABASE_URL ?? '');
});

describe.skipIf(!live)('trash file SQL — live regression (Stage 21)', () => {
  it('restoreItem file tenant lookup parses and yields a clean not_found (never a raw pg 500)', async () => {
    await expect(
      restoreItem('usr_regression_nonexistent', 'file', 'fil_regression_nonexistent'),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('purgeItem file tenant lookup parses and yields a clean not_found (never a raw pg 500)', async () => {
    await expect(
      purgeItem('usr_regression_nonexistent', 'file', 'fil_regression_nonexistent'),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('rejects with a controlled AppError, never a raw pg DatabaseError', async () => {
    try {
      await restoreItem('usr_regression_nonexistent', 'file', 'fil_regression_nonexistent');
      expect.unreachable('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).errorCode).toBe('not_found');
      // pg DatabaseError carries an SQLSTATE `code` (e.g. 42P01 for the old
      // alias bug); a controlled AppError never does.
      expect((err as { code?: string }).code).toBeUndefined();
    }
  });
});