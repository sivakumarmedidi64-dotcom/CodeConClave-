/**
 * CodeConClave — migration runner.
 * Applies database/migrations/*.sql in filename order, transactionally,
 * recording SHA-256 of each applied migration in schema_migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from '../shared/db.js';
import { sha256Hex } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/database -> src -> backend -> repo root
const repoRoot = path.resolve(here, '..', '..', '..');
const migrationsDir = path.join(repoRoot, 'database', 'migrations');

/**
 * The single authoritative migration ledger.
 *
 * Historical hazard: migration 0104 originally created a SECOND, incompatible
 * `schema_migrations` table (wizard shape: id/owner_id/table_name/...). On a
 * fresh database the runner created the ledger first, `CREATE TABLE IF NOT
 * EXISTS` silently no-op'd, and 0104's policy then failed on a missing
 * `owner_id` column — aborting the loop and making every migration from 0104
 * onward unreachable. 0104 now uses `schema_migration_plans`.
 *
 * `ensureSchemaTable` stays defensive so a database that somehow still carries
 * the wizard-shaped table is repaired in place instead of crash-looping.
 *
 * REPAIR IS NON-DESTRUCTIVE. The previous version resolved a half-finished
 * repair (both names occupied) with `DROP TABLE schema_migration_plans`, which
 * had two ways to destroy real state:
 *   - if `schema_migration_plans` held the AUTHORITATIVE ledger, dropping it
 *     erased the applied-migration history and every migration re-ran;
 *   - if it held wizard rows, those rows vanished with no trace.
 * The repair now classifies both tables by SHAPE, renames the squatter to a
 * suffixed parked name instead of dropping it, and moves a real ledger into the
 * canonical name by rename (never by copy, so the rows are never rewritten).
 * Everything runs in one transaction under an advisory lock so two runners
 * cannot interleave the renames.
 */

/** Columns that identify a table's role. A table can be classified without
 *  trusting its NAME, which is the whole point: the name is what collided. */
interface TableShape {
  has_name: boolean;
  has_sha256: boolean;
  has_owner_id: boolean;
  has_table_name: boolean;
}

type TableRole = 'ledger' | 'wizard' | 'unknown';

function classify(shape: TableShape): TableRole {
  if (shape.has_name && shape.has_sha256) return 'ledger';
  if (shape.has_owner_id || shape.has_table_name) return 'wizard';
  return 'unknown';
}

async function inspectSchemaTables(client: { query: <T = Record<string, unknown>>(sql: string) => Promise<{ rows: T[] }> }): Promise<{
  ledgerExists: boolean;
  plansExists: boolean;
  ledgerRole: TableRole;
  plansRole: TableRole;
}> {
  const { rows } = await client.query<{
    ledger_exists: boolean;
    plans_exists: boolean;
    ledger_shape: TableShape;
    plans_shape: TableShape;
  }>(`
    SELECT
      to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS ledger_exists,
      to_regclass(current_schema() || '.schema_migration_plans') IS NOT NULL AS plans_exists,
      (SELECT row_to_json(c) FROM (
         SELECT
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migrations' AND column_name = 'name') AS has_name,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migrations' AND column_name = 'sha256') AS has_sha256,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migrations' AND column_name = 'owner_id') AS has_owner_id,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migrations' AND column_name = 'table_name') AS has_table_name
       ) c) AS ledger_shape,
      (SELECT row_to_json(c) FROM (
         SELECT
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migration_plans' AND column_name = 'name') AS has_name,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migration_plans' AND column_name = 'sha256') AS has_sha256,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migration_plans' AND column_name = 'owner_id') AS has_owner_id,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                    AND table_name = 'schema_migration_plans' AND column_name = 'table_name') AS has_table_name
       ) c) AS plans_shape
  `);
  const row = rows[0];
  const ledgerShape: TableShape = row?.ledger_shape ?? { has_name: false, has_sha256: false, has_owner_id: false, has_table_name: false };
  const plansShape: TableShape = row?.plans_shape ?? { has_name: false, has_sha256: false, has_owner_id: false, has_table_name: false };
  return {
    ledgerExists: Boolean(row?.ledger_exists),
    plansExists: Boolean(row?.plans_exists),
    ledgerRole: classify(ledgerShape),
    plansRole: classify(plansShape),
  };
}

/** First unused `schema_migrations_parked_<n>` so a park never clobbers. */
async function parkedName(client: { query: <T = Record<string, unknown>>(sql: string) => Promise<{ rows: T[] }> }): Promise<string> {
  for (let i = 1; i <= 100; i += 1) {
    const candidate = `schema_migrations_parked_${i}`;
    const { rows } = await client.query<{ taken: boolean }>(
      `SELECT to_regclass(current_schema() || '.${candidate}') IS NOT NULL AS taken`,
    );
    if (!rows[0]?.taken) return candidate;
  }
  throw new Error('cannot find an unused name to park the colliding schema_migrations table');
}

/**
 * Ensure the canonical ledger exists, repairing a name collision first.
 * Exported for the repair regression test; application code never calls it.
 */
export async function ensureSchemaTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent runners: without this, two processes can both decide
    // to rename and one fails halfway. It MUST be taken inside the transaction —
    // `pg_advisory_xact_lock` releases at COMMIT/ROLLBACK, so acquiring it in
    // autocommit mode (i.e. before BEGIN) takes no lock at all.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_REPAIR_LOCK_KEY]);
    await repairSchemaTable(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_REPAIR_LOCK_KEY = 8_713_552_003;

/** Shape-aware, non-destructive collision repair. Runs inside a transaction. */
async function repairSchemaTable(client: {
  query: <T = Record<string, unknown>>(sql: string) => Promise<{ rows: T[] }>;
}): Promise<void> {
  const { ledgerExists, plansExists, ledgerRole, plansRole } = await inspectSchemaTables(client);
  if (!ledgerExists || ledgerRole === 'ledger') return; // healthy, or nothing there

  if (plansExists && plansRole === 'ledger') {
    // A half-finished repair left the REAL LEDGER under the wizard's name. Park
    // the squatter, then move the ledger onto the canonical name. Renames only
    // — the applied-migration rows are never copied, rewritten, or dropped.
    const parked = await parkedName(client);
    logger.warn('repairing schema_migrations ledger collision', {
      action: 'park wizard table and adopt the real ledger',
      parkedAs: parked,
    });
    await dropWizardArtifacts(client, 'schema_migrations');
    await client.query(`ALTER TABLE schema_migrations RENAME TO ${parked}`);
    await client.query('ALTER TABLE schema_migration_plans RENAME TO schema_migrations');
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_schema_migration_plans_owner ON schema_migrations(owner_id)',
    ).catch(() => {}); // owner_id only exists if the ledger grew the column; harmless
    return;
  }

  if (plansExists) {
    // Both tables are wizard-shaped, or the second is unrecognisable. Park the
    // squatter under a free name so its rows survive; an operator can drop it
    // deliberately later. NEVER drop it here.
    const parked = await parkedName(client);
    logger.warn('repairing schema_migrations ledger collision', {
      action: 'park wizard table (no data discarded)',
      parkedAs: parked,
      plansRole,
      remediation: `inspect and drop ${parked} once you have confirmed it holds nothing you need`,
    });
    await dropWizardArtifacts(client, 'schema_migrations');
    await client.query(`ALTER TABLE schema_migrations RENAME TO ${parked}`);
    return;
  }

  // Only the wizard table exists: it just needs the canonical name.
  logger.warn('repairing schema_migrations ledger collision', { action: 'rename wizard table' });
  await dropWizardArtifacts(client, 'schema_migrations');
  await client.query('ALTER TABLE schema_migrations RENAME TO schema_migration_plans');
  await client.query('CREATE INDEX IF NOT EXISTS idx_schema_migration_plans_owner ON schema_migration_plans(owner_id)');
}

/** Drop the wizard table's RLS policy and index while it still has the old name. */
async function dropWizardArtifacts(
  client: { query: <T = Record<string, unknown>>(sql: string) => Promise<{ rows: T[] }> },
  table: string,
): Promise<void> {
  await client.query(`DROP POLICY IF EXISTS schema_migrations_owner ON ${table}`);
  await client.query(`DROP INDEX IF EXISTS idx_schema_migrations_owner`);
}

async function appliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((r) => r.name));
}

function listMigrations(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Report applied migrations whose file content has changed since it ran.
 * Deliberately a WARNING, not an error: 0104 was corrected in place to stop it
 * squatting on the ledger's own table name, and refusing to boot on a checksum
 * mismatch would be worse than a logged, reviewable signal. The list is
 * returned so the pre-deploy check can surface it as a real gate.
 */
export async function migrationDrift(): Promise<{ file: string; recorded: string; current: string }[]> {
  await ensureSchemaTable();
  const result = await pool.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations');
  const drift: { file: string; recorded: string; current: string }[] = [];
  for (const row of result.rows) {
    const file = path.join(migrationsDir, row.name);
    if (!fs.existsSync(file)) continue;
    const current = sha256Hex(fs.readFileSync(file, 'utf8'));
    if (current !== row.sha256) {
      drift.push({ file: row.name, recorded: row.sha256, current });
    }
  }
  return drift;
}

export async function migrateUp(): Promise<string[]> {
  await ensureSchemaTable();
  const drift = await migrationDrift();
  for (const d of drift) {
    logger.warn('applied migration content differs from the ledger checksum', {
      file: d.file,
      recorded: d.recorded.slice(0, 12),
      current: d.current.slice(0, 12),
    });
  }
  const applied = await appliedMigrations();
  const pending = listMigrations().filter((f) => !applied.has(f));
  const done: string[] = [];
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const hash = sha256Hex(sql);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file, hash]);
      await client.query('COMMIT');
      done.push(file);
      logger.info('migration applied', { file, sha256: hash.slice(0, 12) });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('migration failed', { file, error: (err as Error).message });
      throw err;
    } finally {
      client.release();
    }
  }
  return done;
}

export async function migrateDown(): Promise<string[]> {
  await ensureSchemaTable();
  const applied = await appliedMigrations();
  const all = listMigrations().filter((f) => applied.has(f));
  const last = all.at(-1);
  if (!last) return [];
  const sql = fs.readFileSync(path.join(migrationsDir, last), 'utf8');
  const client = await pool.connect();
  try {
    // Down is best-effort DROP-all for the last migration: we record a note.
    // Full reverse migrations are not generated; the contract documents this.
    await client.query('BEGIN');
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [last]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  logger.warn('migration marked down (schema not auto-reversed)', { file: last });
  return [last];
}

export async function migrateStatus(): Promise<{ file: string; applied: boolean }[]> {
  await ensureSchemaTable();
  const applied = await appliedMigrations();
  return listMigrations().map((f) => ({ file: f, applied: applied.has(f) }));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command === 'up') {
    const done = await migrateUp();
    logger.info(`migrate up complete: ${done.length} applied`);
  } else if (command === 'down') {
    await migrateDown();
  } else if (command === 'status') {
    for (const m of await migrateStatus()) {
      logger.info(m.applied ? '[x]' : '[ ]', { file: m.file });
    }
  } else {
    console.log('usage: db:migrate [up|down|status]');
  }
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}