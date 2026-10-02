/**
 * CodeConClave — migration-ledger collision repair must never destroy state.
 *
 * Migration 0104 once created a wizard-shaped `schema_migrations` table
 * (id/owner_id/table_name/…) that squatted on the ledger's own name. The first
 * fix resolved the resulting half-finished repair with
 *   DROP TABLE IF EXISTS schema_migration_plans
 * which is unsafe in two distinct ways:
 *   1. if `schema_migration_plans` held the REAL ledger, the applied-migration
 *      history was destroyed and every migration would re-run;
 *   2. if it held wizard rows, those rows disappeared with no trace.
 *
 * The repair is now classified by table SHAPE (never by name), renames the
 * squatter to a parked name, and adopts a real ledger by rename. These tests
 * pin all four shapes, the advisory lock, and the rollback path.
 *
 * No database: the pg pool is mocked and the assertions are on the exact SQL the
 * repair issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Shape {
  has_name: boolean;
  has_sha256: boolean;
  has_owner_id: boolean;
  has_table_name: boolean;
}

const LEDGER: Shape = { has_name: true, has_sha256: true, has_owner_id: false, has_table_name: false };
const WIZARD: Shape = { has_name: false, has_sha256: false, has_owner_id: true, has_table_name: true };
const UNKNOWN: Shape = { has_name: false, has_sha256: false, has_owner_id: false, has_table_name: false };

const harness = vi.hoisted(() => {
  const state = {
    ledgerExists: false,
    plansExists: false,
    ledgerShape: { has_name: true, has_sha256: true, has_owner_id: false, has_table_name: false } as Record<string, boolean>,
    plansShape: { has_name: true, has_sha256: true, has_owner_id: false, has_table_name: false } as Record<string, boolean>,
    takenCandidates: [] as string[],
    calls: [] as string[],
    failOn: null as string | null,
    released: false,
  };
  const query = async (text: string) => {
    state.calls.push(text);
    if (state.failOn && text.includes(state.failOn)) throw new Error(`boom on ${state.failOn}`);
    if (text.includes('AS ledger_exists')) {
      return {
        rows: [
          {
            ledger_exists: state.ledgerExists,
            plans_exists: state.plansExists,
            ledger_shape: state.ledgerShape,
            plans_shape: state.plansShape,
          },
        ],
      };
    }
    const taken = text.match(/schema_migrations_parked_(\d+)'\) IS NOT NULL AS taken/);
    if (taken) return { rows: [{ taken: state.takenCandidates.includes(`schema_migrations_parked_${taken[1]}`) }] };
    return { rows: [] };
  };
  const client = {
    query,
    release: () => {
      state.released = true;
    },
  };
  return { state, pool: { connect: async () => client, query, end: async () => {} } };
});
vi.mock('../shared/db.js', () => harness);

vi.mock('../shared/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureSchemaTable } from './migrate.js';

beforeEach(() => {
  harness.state.calls = [];
  harness.state.ledgerExists = false;
  harness.state.plansExists = false;
  harness.state.ledgerShape = { ...LEDGER };
  harness.state.plansShape = { ...LEDGER };
  harness.state.takenCandidates = [];
  harness.state.failOn = null;
  harness.state.released = false;
});

function sqlMatching(pattern: RegExp): string[] {
  return harness.state.calls.filter((c) => pattern.test(c));
}

describe('ensureSchemaTable — healthy database', () => {
  it('creates the ledger and touches nothing else', async () => {
    await ensureSchemaTable();
    expect(sqlMatching(/CREATE TABLE IF NOT EXISTS schema_migrations/)).toHaveLength(1);
    expect(sqlMatching(/RENAME TO/)).toHaveLength(0);
    expect(sqlMatching(/DROP/)).toHaveLength(0);
  });

  it('does not repair a healthy ledger table that is already the right shape', async () => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...LEDGER };
    await ensureSchemaTable();
    expect(sqlMatching(/RENAME TO/)).toHaveLength(0);
    expect(sqlMatching(/DROP/)).toHaveLength(0);
  });

  it('serialises concurrent runners with a transaction-scoped advisory lock', async () => {
    await ensureSchemaTable();
    const order = harness.state.calls.map((c) => c.trim().split(/\s+/)[0]);
    expect(order[0]).toBe('BEGIN');
    expect(order[order.length - 1]).toBe('COMMIT');
    // The lock is only held if it is taken AFTER BEGIN: taken in autocommit it
    // is released immediately and serialises nothing.
    const lockAt = harness.state.calls.findIndex((c) => c.includes('pg_advisory_xact_lock'));
    expect(lockAt).toBeGreaterThan(0);
    expect(harness.state.calls[lockAt]!.trim().startsWith('SELECT')).toBe(true);
  });

  it('always releases the pooled client', async () => {
    await ensureSchemaTable();
    expect(harness.state.released).toBe(true);
  });
});

describe('ensureSchemaTable — wizard squatting on the ledger name', () => {
  it('renames it to the wizard name when that name is free', async () => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...WIZARD };
    harness.state.plansExists = false;
    await ensureSchemaTable();
    expect(sqlMatching(/ALTER TABLE schema_migrations RENAME TO schema_migration_plans$/m)).toHaveLength(1);
    expect(sqlMatching(/DROP TABLE/)).toHaveLength(0);
  });

  it('drops the wizard RLS policy and index before renaming them away', async () => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...WIZARD };
    await ensureSchemaTable();
    expect(sqlMatching(/DROP POLICY IF EXISTS schema_migrations_owner ON schema_migrations$/m)).toHaveLength(1);
    expect(sqlMatching(/DROP INDEX IF EXISTS idx_schema_migrations_owner/)).toHaveLength(1);
  });
});

describe('ensureSchemaTable — half-finished repair, real ledger under the wizard name', () => {
  beforeEach(() => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...WIZARD };
    harness.state.plansExists = true;
    harness.state.plansShape = { ...LEDGER }; // the authoritative history
  });

  it('ADOPTS the real ledger instead of dropping it', async () => {
    await ensureSchemaTable();
    // The regression: the old code issued this and lost every applied row.
    expect(sqlMatching(/DROP TABLE/)).toHaveLength(0);
    expect(sqlMatching(/ALTER TABLE schema_migration_plans RENAME TO schema_migrations$/m)).toHaveLength(1);
  });

  it('parks the squatter under a fresh name rather than deleting it', async () => {
    await ensureSchemaTable();
    const park = sqlMatching(/ALTER TABLE schema_migrations RENAME TO schema_migrations_parked_\d+$/m);
    expect(park).toHaveLength(1);
    expect(park[0]).toMatch(/parked_1$/);
  });

  it('never copies or rewrites ledger rows', async () => {
    await ensureSchemaTable();
    expect(sqlMatching(/INSERT INTO schema_migrations/)).toHaveLength(0);
    expect(sqlMatching(/CREATE TABLE .*schema_migration_plans/)).toHaveLength(0);
  });

  it('picks the next free parked name when one is already taken', async () => {
    harness.state.takenCandidates = ['schema_migrations_parked_1', 'schema_migrations_parked_2'];
    await ensureSchemaTable();
    const park = sqlMatching(/RENAME TO schema_migrations_parked_\d+$/m);
    expect(park).toHaveLength(1);
    expect(park[0]).toMatch(/parked_3$/);
  });
});

describe('ensureSchemaTable — both tables unrecognisable', () => {
  it('parks the squatter and still does not drop anything', async () => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...UNKNOWN };
    harness.state.plansExists = true;
    harness.state.plansShape = { ...WIZARD };
    await ensureSchemaTable();
    expect(sqlMatching(/DROP TABLE/)).toHaveLength(0);
    expect(sqlMatching(/RENAME TO schema_migrations_parked_\d+$/m)).toHaveLength(1);
  });
});

describe('ensureSchemaTable — failure handling', () => {
  beforeEach(() => {
    // Reach the rename path so a failure there is actually exercised.
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...WIZARD };
  });

  it('rolls back and releases the client when the repair throws', async () => {
    harness.state.failOn = 'RENAME TO';
    await expect(ensureSchemaTable()).rejects.toThrow(/boom/);
    expect(sqlMatching(/ROLLBACK/)).toHaveLength(1);
    expect(sqlMatching(/COMMIT$/m)).toHaveLength(0);
    expect(harness.state.released).toBe(true);
  });

  it('leaves the ledger uncreated when the transaction is rolled back', async () => {
    harness.state.failOn = 'RENAME TO';
    await expect(ensureSchemaTable()).rejects.toThrow();
    const rollbackAt = harness.state.calls.findIndex((c) => c.trim() === 'ROLLBACK');
    const createAt = harness.state.calls.findIndex((c) => c.includes('CREATE TABLE IF NOT EXISTS schema_migrations'));
    expect(createAt).toBeLessThan(rollbackAt); // never committed
  });

  it('refuses to guess a park name after 100 collisions instead of clobbering one', async () => {
    harness.state.ledgerExists = true;
    harness.state.ledgerShape = { ...WIZARD };
    harness.state.plansExists = true;
    harness.state.plansShape = { ...LEDGER };
    harness.state.takenCandidates = Array.from({ length: 100 }, (_, i) => `schema_migrations_parked_${i + 1}`);
    await expect(ensureSchemaTable()).rejects.toThrow(/unused name/);
    expect(sqlMatching(/RENAME TO/)).toHaveLength(0);
  });
});
