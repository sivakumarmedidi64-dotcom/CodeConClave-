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

async function ensureSchemaTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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

export async function migrateUp(): Promise<string[]> {
  await ensureSchemaTable();
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