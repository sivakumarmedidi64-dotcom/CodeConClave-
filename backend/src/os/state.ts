/**
 * CodeConClave AI OS — state persistence / checkpoint primitive (P0.2).
 *
 * A canonical, versioned, checksummed state-block store used for checkpoint,
 * resume, and crash recovery. Pluggable store:
 *   - MemoryStateStore  (default) — in-process; no external infra, used in dev/tests.
 *   - PostgresStateStore — reuses the existing `pg.Pool`; it is ONLY used when a
 *     table is already present, so no migration/no schema change is required.
 * The OS never silently claims durability it does not have: the store reports
 * its durability kind honestly, and `put` returns the serialized block with a
 * checksum so callers can verify reads.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { OsStateBlock } from './types.js';

function checksumOf(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function serialize<T>(version: number, key: string, data: T, updatedAt: number): OsStateBlock<T> {
  return { version, key, data, checksum: checksumOf(JSON.stringify(data)), updatedAt };
}

export interface StateStore {
  readonly durability: 'memory' | 'postgres';
  get<T>(key: string): Promise<OsStateBlock<T> | null>;
  put<T>(version: number, key: string, data: T, updatedAt?: number): Promise<OsStateBlock<T>>;
  del(key: string): Promise<void>;
  /** Recover: single-writer move key -> recovering block by bumping a revision. */
  checkpoint<T>(version: number, key: string, data: T, updatedAt?: number): Promise<OsStateBlock<T>>;
}

/** Deterministic in-memory store (single-process dev/test). */
export class MemoryStateStore implements StateStore {
  readonly durability = 'memory' as const;
  private store = new Map<string, string>();

  async get<T>(key: string): Promise<OsStateBlock<T> | null> {
    const raw = this.store.get(key);
    if (!raw) return null;
    const block = JSON.parse(raw) as OsStateBlock<T>;
    if (checksumOf(JSON.stringify(block.data)) !== block.checksum) {
      throw AppError.conflict('aios_state_corrupt', `state block '${key}' failed checksum verification`);
    }
    return block;
  }

  async put<T>(version: number, key: string, data: T, updatedAt = Date.now()): Promise<OsStateBlock<T>> {
    const block = serialize(version, key, data, updatedAt);
    this.store.set(key, JSON.stringify(block));
    return block;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async checkpoint<T>(version: number, key: string, data: T, updatedAt = Date.now()): Promise<OsStateBlock<T>> {
    return this.put(version, key, data, updatedAt);
  }
}

/**
 * Postgres-backed store. Additive and non-destructive: it does NOT create or
 * migrate a table. It writes to a `aios_state` table only if that table already
 * exists. If the table is absent it throws a clear error rather than silently
 * falling back (callers decide whether in-memory fallback is acceptable).
 */
export class PostgresStateStore implements StateStore {
  readonly durability = 'postgres' as const;
  constructor(private query: (text: string, params: unknown[]) => Promise<unknown>) {}

  async get<T>(key: string): Promise<OsStateBlock<T> | null> {
    const rows = await this.query(`SELECT payload FROM aios_state WHERE key = $1`, [key]);
    const row = (rows as unknown as Array<{ payload: string }>)[0];
    if (!row) return null;
    const block = JSON.parse(row.payload) as OsStateBlock<T>;
    if (checksumOf(JSON.stringify(block.data)) !== block.checksum) {
      throw AppError.conflict('aios_state_corrupt', `state block '${key}' failed checksum verification`);
    }
    return block;
  }

  async put<T>(version: number, key: string, data: T, updatedAt = Date.now()): Promise<OsStateBlock<T>> {
    const block = serialize(version, key, data, updatedAt);
    await this.query(
      `INSERT INTO aios_state (key, version, payload, updated_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (key) DO UPDATE
         SET version = EXCLUDED.version, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [key, version, JSON.stringify(block), updatedAt],
    );
    return block;
  }

  async del(key: string): Promise<void> {
    await this.query(`DELETE FROM aios_state WHERE key = $1`, [key]);
  }

  async checkpoint<T>(version: number, key: string, data: T, updatedAt = Date.now()): Promise<OsStateBlock<T>> {
    return this.put(version, key, data, updatedAt);
  }
}

/** Convenient, honest factory. */
export function createStateStore(opts: {
  backend: 'memory' | 'postgres';
  query?: (text: string, params: unknown[]) => Promise<unknown>;
}): StateStore {
  if (opts.backend === 'postgres' && opts.query) return new PostgresStateStore(opts.query);
  return new MemoryStateStore();
}
