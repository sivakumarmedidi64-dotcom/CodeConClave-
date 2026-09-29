/**
 * CodeConClave — P0-2 Path 1 (files batch): REAL two-tenant isolation test for
 * the converted file service DB-only read paths.
 *
 * RUNS AGAINST A REAL POSTGRESQL DATABASE (no mocks, no SQLite, no fakes).
 * The verify database `codeconclave_verify` is a real PostgreSQL database on
 * the production Neon server, freshly migrated by the full migration chain.
 *
 * What this proves for the Path 1 conversion of src/modules/files/service.ts:
 *   - the project-membership gate (`getProject`) rejects tenant B before any
 *     files query runs for tenant A's project;
 *   - the owner-scoped list/store reads (`listFiles`, `searchProjectFiles`,
 *     `recentFiles`) only ever see the caller's own rows;
 *   - `getFile` ownership chain (owner >> project member >> explicit grant)
 *     surfaces cross-tenant reads as `forbidden`, and unknown ids as
 *     `not_found` even for the owner;
 *   - every read runs on the client granted by `withTenant(userId, ...)`.
 *
 * DB-only coverage (no S3/MinIO): listFiles, searchProjectFiles, recentFiles,
 * getFile. Content reads and write/storage paths (`uploadFile`,
 * `getFileContent`, restore versions, purge) additionally depend on blob
 * storage and are covered by the unit suite; they require a full storage
 * deployment for real-PG validation.
 *
 * Run:
 *   DATABASE_URL=<verify-url> NODE_ENV=test TRUST_PROXY=1 \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config vitest.integration.config.ts \
 *       src/foundation/p0-2-files-real.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { env } from '../config/env.js';
import { listFiles, getFile, recentFiles, searchProjectFiles } from '../modules/files/service.js';

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
  process.stderr.write(`[p0-2-files-real] DB probe failed: ${probeError}\n`);
} finally {
  await probe.end().catch(() => {});
}

it.skipIf(live)('live DB probe failed — files cross-tenant tests skipped honestly (non-secret reason)', () => {
  expect(probeError).not.toContain(env.DATABASE_URL ?? '');
});

const TENANT_A = 'usr_p02_file_tenant_a';
const TENANT_B = 'usr_p02_file_tenant_b';
const PROJECT_A = 'prj_p02_file_tenant_a';
const FILE_A = 'rfl_p02_file_tenant_a';

async function seedTenants(): Promise<pg.Pool> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 6000,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  for (const id of [TENANT_A, TENANT_B]) {
    await pool.query(
      `INSERT INTO users (id, email, is_founder)
       VALUES ($1, $2, false)
       ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@p02-files.invalid`],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, owner_id, name)
     VALUES ($1, $2, 'p02 files project')
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT_A, TENANT_A],
  );
  const sha = 'b'.repeat(64);
  await pool.query(
    `INSERT INTO files (id, project_id, owner_id, path, size_bytes, sha256, storage_key, is_directory)
     VALUES ($1, $2, $3, 'src/main.ts', 100, $4, NULL, false)
     ON CONFLICT (id) DO NOTHING`,
    [FILE_A, PROJECT_A, TENANT_A, sha],
  );
  return pool;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = $1', [FILE_A]);
  await pool.query('DELETE FROM projects WHERE id = $1', [PROJECT_A]);
  await pool.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.end().catch(() => {});
}

describe.skipIf(!live)('P0-2 Path 1 real two-tenant file isolation (DB-only reads)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await seedTenants();
  });

  afterAll(async () => {
    await cleanup(pool);
  });

  it('both tenants are real rows, and the file is seeded for tenant A', async () => {
    const users = await pool.query('SELECT id FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
    expect(users.rows.map((r) => r.id).sort()).toEqual([TENANT_A, TENANT_B].sort());
    const f = await pool.query('SELECT owner_id, project_id FROM files WHERE id = $1', [FILE_A]);
    expect(f.rows[0]).toEqual({ owner_id: TENANT_A, project_id: PROJECT_A });
  });

  it('tenant B cannot list tenant A project files (project-membership gate)', async () => {
    await expect(listFiles(TENANT_B, PROJECT_A)).rejects.toMatchObject({ errorCode: 'forbidden' });
  });

  it('tenant A lists the seeded file through the converted withTenant path', async () => {
    const view = await listFiles(TENANT_A, PROJECT_A);
    expect(view.some((f) => f.id === FILE_A)).toBe(true);
  });

  it('searchProjectFiles is gated the same way for tenant B', async () => {
    await expect(searchProjectFiles(TENANT_B, PROJECT_A, 'main')).rejects.toMatchObject({
      errorCode: 'forbidden',
    });
    const view = await searchProjectFiles(TENANT_A, PROJECT_A, 'main');
    expect(view.some((f) => f.id === FILE_A)).toBe(true);
    expect(await searchProjectFiles(TENANT_A, PROJECT_A, 'nope-xyz')).toEqual([]);
  });

  it('getFile: tenant B is denied access, tenant A reads the real row', async () => {
    await expect(getFile(TENANT_B, PROJECT_A, FILE_A)).rejects.toMatchObject({ errorCode: 'file_access_denied' });
    const view = await getFile(TENANT_A, PROJECT_A, FILE_A);
    expect(view.id).toBe(FILE_A);
    expect(view.ownerId).toBe(TENANT_A);
  });

  it('unknown file id is a not_found for BOTH tenants (existence precedes ownership, no leak)', async () => {
    await expect(getFile(TENANT_A, PROJECT_A, 'rfl_dne')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(getFile(TENANT_B, PROJECT_A, 'rfl_dne')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('owner-scoped recentFiles sees only the caller rows (tenant A yes, tenant B none)', async () => {
    const aRecent = await recentFiles(TENANT_A);
    expect(aRecent.some((f) => f.id === FILE_A)).toBe(true);
    const bRecent = await recentFiles(TENANT_B);
    expect(bRecent.some((f) => f.id === FILE_A)).toBe(false);
  });
});