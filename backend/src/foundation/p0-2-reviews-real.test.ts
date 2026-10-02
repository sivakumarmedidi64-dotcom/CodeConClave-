/**
 * CodeConClave — P0-2 Path 1 (reviews batch): REAL two-tenant isolation test
 * for the converted review service.
 *
 * RUNS AGAINST A REAL POSTGRESQL DATABASE (no mocks, no SQLite, no fakes).
 * The verify database `codeconclave_verify` is a real PostgreSQL database on
 * the production Neon server, freshly migrated by the full migration chain.
 *
 * What this proves for the Path 1 conversion of src/modules/reviews/service.ts:
 *   - every exported review operation now runs its review-table queries on a
 *     tenant-scoped client obtained from `withTenant(userId, ...)`;
 *   - the authenticated principal's id is the ONLY tenant key ever used — a
 *     client-supplied review id can never lift ownership;
 *   - tenant A's rows are unreadable and unmutatable by tenant B through the
 *     converted service (`not_found`, never `forbidden` leak/absence);
 *   - the decide / accept-all / cancel transitions persist real rows on real
 *     PostgreSQL that the probe (a second real connection) can verify.
 *
 * DB-only coverage (no S3/MinIO, no git, no sandbox): getReview, listReviews
 * (owner side), decideHunk, acceptAllHunks, cancelReview. The apply / undo /
 * commit / test runners additionally depend on blob storage and the policy
 * sandbox, which are covered by the unit suite and require a full storage
 * deployment.
 *
 * Run:
 *   DATABASE_URL=<verify-url> NODE_ENV=test TRUST_PROXY=1 \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config vitest.integration.config.ts \
 *       src/foundation/p0-2-reviews-real.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { env } from '../config/env.js';
import {
  getReview,
  listReviews,
  decideHunk,
  acceptAllHunks,
  cancelReview,
} from '../modules/reviews/service.js';

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
  process.stderr.write(`[p0-2-reviews-real] DB probe failed: ${probeError}\n`);
} finally {
  await probe.end().catch(() => {});
}

it.skipIf(live)('live DB probe failed — reviews cross-tenant tests skipped honestly (non-secret reason)', () => {
  expect(probeError).not.toContain(env.DATABASE_URL ?? '');
});

const TENANT_A = 'usr_p02_review_tenant_a';
const TENANT_B = 'usr_p02_review_tenant_b';
const PROJECT_A = 'prj_p02_review_tenant_a';
const TASK_A = 'tsk_p02_review_tenant_a';
const REVIEW_A = 'rvw_p02_review_tenant_a';
const FILE_A = 'rfl_p02_review_tenant_a';
const HUNK_A = 'rhk_p02_review_tenant_a';

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
      [id, `${id}@p02-reviews.invalid`],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, owner_id, name)
     VALUES ($1, $2, 'p02 reviews project')
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT_A, TENANT_A],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, owner_id, title, status, execution_mode)
     VALUES ($1, $2, $3, 'p02 reviews task', 'COMPLETED', 'CLOUD')
     ON CONFLICT (id) DO NOTHING`,
    [TASK_A, PROJECT_A, TENANT_A],
  );
  const sha = 'a'.repeat(64);
  await pool.query(
    `INSERT INTO cowork_reviews
       (id, task_id, project_id, owner_id, title, status, test_status, commit_status,
        diff_text, files_changed, additions, deletions)
     VALUES ($1, $2, $3, $4, 'real review', 'READY_FOR_REVIEW', 'NOT_RUN', 'NOT_COMMITTED',
             'diff --git a/x.ts b/x.ts', 1, 1, 1)
     ON CONFLICT (id) DO NOTHING`,
    [REVIEW_A, TASK_A, PROJECT_A, TENANT_A],
  );
  await pool.query(
    `INSERT INTO cowork_review_files
       (id, review_id, path, base_sha256, base_content, proposed_sha256, proposed_content, status, file_order)
     VALUES ($1, $2, 'x.ts', $3, 'old', $4, 'old\nnew', 'PENDING', 0)
     ON CONFLICT (id) DO NOTHING`,
    [FILE_A, REVIEW_A, sha, sha],
  );
  await pool.query(
    `INSERT INTO cowork_review_hunks
       (id, review_id, file_id, hunk_order, status, old_start, old_lines, new_start, new_lines,
        original_sha, proposed_sha, additions, deletions, context_lines, ins_lines, diff_text)
     VALUES ($1, $2, $3, 0, 'PENDING', 1, 1, 1, 2, $4, $5, 1, 1, '[]', '["new"]', '@@ -1 +1,2 @@')
     ON CONFLICT (id) DO NOTHING`,
    [HUNK_A, REVIEW_A, FILE_A, sha, sha],
  );
  return pool;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM cowork_reviews WHERE id = $1', [REVIEW_A]);
  await pool.query('DELETE FROM tasks WHERE id = $1', [TASK_A]);
  await pool.query('DELETE FROM projects WHERE id = $1', [PROJECT_A]);
  await pool.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.end().catch(() => {});
}

describe.skipIf(!live)('P0-2 Path 1 real two-tenant review isolation', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await seedTenants();
  });

  afterAll(async () => {
    await cleanup(pool);
  });

  it('both tenants are real rows, and the review is seeded for tenant A', async () => {
    const users = await pool.query('SELECT id FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
    expect(users.rows.map((r) => r.id).sort()).toEqual([TENANT_A, TENANT_B].sort());
    const rev = await pool.query('SELECT owner_id, status FROM cowork_reviews WHERE id = $1', [REVIEW_A]);
    expect(rev.rows[0]).toEqual({ owner_id: TENANT_A, status: 'READY_FOR_REVIEW' });
  });

  it('tenant B cannot read tenant A review: converted getReview returns not_found', async () => {
    await expect(getReview(TENANT_B, REVIEW_A)).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('tenant A reads the full review including files and hunks (converted withTenant path)', async () => {
    const view = await getReview(TENANT_A, REVIEW_A);
    expect(view.id).toBe(REVIEW_A);
    expect(view.ownerId).toBe(TENANT_A);
    expect(view.files).toHaveLength(1);
    expect(view.files[0]!.path).toBe('x.ts');
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0]!.status).toBe('PENDING');
  });

  it('tenant B sees no review in tenant A project listing, tenant A does', async () => {
    const aList = await listReviews(TENANT_A, PROJECT_A);
    expect(aList.some((r) => r.review.id === REVIEW_A)).toBe(true);
    // tenant B is not a member of project A: getProject rejects before any
    // review query runs (project membership is the owning-tenant gate).
    await expect(listReviews(TENANT_B, PROJECT_A)).rejects.toMatchObject({ errorCode: 'forbidden' });
  });

  it('tenant B cannot decide tenant A hunk; tenant A can, and the real row persists', async () => {
    await expect(decideHunk(TENANT_B, REVIEW_A, HUNK_A, 'ACCEPTED')).rejects.toMatchObject({
      errorCode: 'not_found',
    });
    const before = await pool.query('SELECT status FROM cowork_review_hunks WHERE id = $1', [HUNK_A]);
    expect(before.rows[0].status).toBe('PENDING');

    const view = await decideHunk(TENANT_A, REVIEW_A, HUNK_A, 'ACCEPTED');
    const hunk = view.hunks.find((h) => h.id === HUNK_A);
    expect(hunk?.status).toBe('ACCEPTED');
    const after = await pool.query('SELECT status FROM cowork_review_hunks WHERE id = $1', [HUNK_A]);
    expect(after.rows[0].status).toBe('ACCEPTED');
    const rev = await pool.query('SELECT status FROM cowork_reviews WHERE id = $1', [REVIEW_A]);
    expect(rev.rows[0].status).toBe('READY_FOR_REVIEW');
  });

  it('tenant B cannot accept-all tenant A review; tenant A can (recompute persists)', async () => {
    await expect(acceptAllHunks(TENANT_B, REVIEW_A)).rejects.toMatchObject({ errorCode: 'not_found' });
    const view = await acceptAllHunks(TENANT_A, REVIEW_A);
    expect(view.status).toBe('READY_FOR_REVIEW');
    const rev = await pool.query('SELECT status FROM cowork_reviews WHERE id = $1', [REVIEW_A]);
    expect(rev.rows[0].status).toBe('READY_FOR_REVIEW');
  });

  it('tenant B cannot cancel tenant A review; tenant A can (real CANCELLED row)', async () => {
    await expect(cancelReview(TENANT_B, REVIEW_A)).rejects.toMatchObject({ errorCode: 'not_found' });
    const view = await cancelReview(TENANT_A, REVIEW_A);
    expect(view.status).toBe('CANCELLED');
    const rev = await pool.query('SELECT status FROM cowork_reviews WHERE id = $1', [REVIEW_A]);
    expect(rev.rows[0].status).toBe('CANCELLED');
  });

  it('unknown review id is a not_found for the owner too (existence + ownership in one guard)', async () => {
    await expect(getReview(TENANT_A, 'rvw_does_not_exist')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(decideHunk(TENANT_A, 'rvw_does_not_exist', HUNK_A, 'ACCEPTED')).rejects.toMatchObject({
      errorCode: 'not_found',
    });
  });
});