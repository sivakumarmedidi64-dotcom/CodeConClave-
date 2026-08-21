/**
 * CodeConClave — DNA foundation tests (Section: DNA versioning + branches).
 * Covers: version-1 creation with snapshot, versioning on update, branch
 * conflict detection, conflict preservation + resolution, restore.
 * DB interaction is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { AppError } from '../shared/errors.js';
import { DnaKind, DnaScope } from '@codeconclave/shared';
import { saveDna, updateDna, createBranch, mergeBranches, restoreDnaVersion } from '../modules/dna/service.js';

const NOW = Date.now();

function dnaRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    owner_id: 'u1',
    kind: DnaKind.PROJECT_CONTEXT,
    scope: 'MAIN',
    title: 'block',
    content: 'v1 content',
    version: 1,
    parent_version_id: null,
    conflict_state: 'NONE',
    deleted_at: null,
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    ...overrides,
  };
}

function resolveDna(
  branchId: string,
  baseId: string,
  branchOverrides: Record<string, unknown>,
  baseOverrides: Record<string, unknown>,
  fetched: Map<string, Record<string, unknown>>,
) {
  return (text: string, params: unknown[]): unknown[] | null => {
    if (text.includes('SELECT 1 FROM projects')) return [{}];
    if (text.includes('SELECT content_snapshot FROM dna_versions')) return [{ content_snapshot: 'old snapshot' }];
    if (text.includes('FROM dna WHERE id = $1')) {
      const id = String(params[0]);
      if (id === branchId) return [{ ...dnaRow(branchId, { scope: 'BRANCH', ...branchOverrides }), ...(fetched.get(branchId) ?? {}) }];
      if (id === baseId) return [{ ...dnaRow(baseId, baseOverrides), ...(fetched.get(baseId) ?? {}) }];
      return [dnaRow(id)];
    }
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
});

describe('saveDna — version 1 + snapshot', () => {
  it('creates the block at version 1 with a version snapshot and conflict_state NONE', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) return [dnaRow(String(params[0]))];
      return null;
    };
    const saved = await saveDna('u1', {
      projectId: 'p1',
      kind: DnaKind.DECISION,
      title: 'decision',
      content: 'use TypeScript',
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO dna (id, project_id'))!;
    expect(insert.params[4]).toBe('MAIN'); // default scope
    expect(insert.params[7]).toBe(1); // version
    expect(insert.params[8]).toBe(null); // parent_version_id
    expect(insert.text).toContain("'NONE'");
    const snapshot = db.state.calls.find((c) => c.text.includes('INSERT INTO dna_versions'))!;
    expect(snapshot.params[2]).toBe(1);
    expect(snapshot.params[3]).toBe('use TypeScript');
    expect(saved.version).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.created' }));
  });

  it('falls back unknown kinds to PROJECT_CONTEXT and honors BRANCH scope', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) return [dnaRow(String(params[0]))];
      return null;
    };
    await saveDna('u1', { projectId: 'p1', kind: 'NOPE' as DnaKind, title: 'x', content: 'y', scope: 'BRANCH' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO dna (id, project_id'))!;
    expect(insert.params[3]).toBe(DnaKind.PROJECT_CONTEXT);
    expect(insert.params[4]).toBe('BRANCH');
  });

  it('rejects saving to an inaccessible project', async () => {
    db.state.resolve = (text) => (text.includes('SELECT 1 FROM projects') ? [] : null);
    await expect(
      saveDna('u1', { projectId: 'ghost', kind: DnaKind.DECISION, title: 'x', content: 'y' }),
    ).rejects.toThrow(AppError);
  });
});

describe('updateDna — versioned updates', () => {
  it('bumps the version and snapshots content on update', async () => {
    const existing = dnaRow('d1', { version: 3 });
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) {
        return [params[0] === 'd1' ? existing : dnaRow(String(params[0]))];
      }
      return null;
    };
    const updated = await updateDna('u1', 'd1', { content: 'v4 content' });
    expect(updated.version).toBe(3);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE dna SET'))!;
    expect(upd.text).toContain('version = version + 1');
    const snapshot = db.state.calls.find((c) => c.text.includes('INSERT INTO dna_versions'))!;
    expect(snapshot.params[2]).toBe(4);
  });

  it('restoreDnaVersion restores the snapshot content with an audit trail', async () => {
    const existing = dnaRow('d1', { version: 5, content: 'current' });
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT content_snapshot FROM dna_versions')) return [{ content_snapshot: 'old snapshot' }];
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) {
        return [params[0] === 'd1' ? existing : dnaRow(String(params[0]))];
      }
      return null;
    };
    await restoreDnaVersion('u1', 'd1', 2);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE dna SET'))!;
    expect(upd.params[1]).toBe('old snapshot');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.restored' }));
  });
});

describe('mergeBranches — conflict detection and resolution', () => {
  const branchId = 'br-1';
  const baseId = 'bs-1';

  it('detects conflicts when the base changed after the branch was created', async () => {
    const fetched = new Map<string, Record<string, unknown>>();
    db.state.resolve = resolveDna(
      branchId,
      baseId,
      { created_at: new Date(NOW - 5_000), updated_at: new Date(NOW - 5_000) },
      { updated_at: new Date(NOW - 100) },
      fetched,
    );
    await expect(mergeBranches('u1', 'p1', branchId, baseId)).rejects.toMatchObject({ errorCode: 'dna_conflict' });
    const conflict = db.state.calls.find((c) => c.text.includes('INSERT INTO dna_conflicts'))!;
    expect(conflict.text).toContain("'CONFLICT'");
    const mark = db.state.calls.find((c) => c.text.includes("conflict_state = 'CONFLICT'"))!;
    expect(mark).toBeDefined();
  });

  it('merges cleanly when the base has not changed since branching', async () => {
    const fetched = new Map<string, Record<string, unknown>>();
    db.state.resolve = resolveDna(
      branchId,
      baseId,
      { created_at: new Date(NOW - 5_000), updated_at: new Date(NOW - 5_000) },
      { updated_at: new Date(NOW - 20_000) },
      fetched,
    );
    const merged = await mergeBranches('u1', 'p1', branchId, baseId, 'final resolution');
    expect(merged).toBeDefined();
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE dna SET conflict_state = \'RESOLVED\''))!;
    expect(upd.params[1]).toBe(branchId);
    expect(upd.params[2]).toBe('final resolution');
    expect(upd.text).toContain("scope = 'MAIN'");
    const conflictReset = db.state.calls.find((c) => c.text.includes('UPDATE dna_conflicts SET state'))!;
    expect(conflictReset.text).toContain("'RESOLVED'");
  });

  it('merges with branch content when no explicit resolution is given', async () => {
    const fetched = new Map<string, Record<string, unknown>>();
    db.state.resolve = resolveDna(
      branchId,
      baseId,
      { created_at: new Date(NOW - 5_000), updated_at: new Date(NOW - 5_000), content: 'branch content' },
      { updated_at: new Date(NOW - 20_000), content: 'base content' },
      fetched,
    );
    await mergeBranches('u1', 'p1', branchId, baseId);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE dna SET conflict_state = \'RESOLVED\''))!;
    expect(upd.params[2]).toBe('branch content');
  });

  it('rejects merging when scopes are wrong (branch/base pairing)', async () => {
    db.state.resolve = resolveDna(
      branchId,
      baseId,
      { scope: 'MAIN' },
      { scope: 'BRANCH' },
      new Map<string, Record<string, unknown>>(),
    );
    await expect(mergeBranches('u1', 'p1', branchId, baseId)).rejects.toMatchObject({ errorCode: 'merge_invalid' });
  });
});

describe('createBranch', () => {
  it('creates a BRANCH from a base block of the same kind', async () => {
    const fetched = new Map<string, Record<string, unknown>>();
    db.state.resolve = resolveDna('br-new', 'bs-1', {}, {}, fetched);
    const branch = await createBranch('u1', 'p1', 'bs-1', 'branch title', 'branch content');
    expect(branch).toBeDefined();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO dna (id, project_id'))!;
    expect(insert.params[4]).toBe('BRANCH');
    expect(insert.params[3]).toBe(DnaKind.PROJECT_CONTEXT);
  });

  it('forbids branching across projects', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) return [dnaRow(String(params[0]), { project_id: 'other-project' })];
      return null;
    };
    await expect(createBranch('u1', 'p1', 'bs-1', 't', 'c')).rejects.toThrow(AppError);
  });
});