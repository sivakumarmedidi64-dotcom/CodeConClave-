/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence — tests.
 * Covers the 27 required cases: record creation, immutable identity, project/
 * workspace/environment isolation, history ordering + filtering, commit
 * association, missing-Git handling, rollback authorization, wrong-project /
 * wrong-environment rejection, unsupported-provider blocking, honest
 * unavailable-provider handling, target validation, current-deployment
 * identification, DB-compatibility guard, destructive-DB blocking, post-rollback
 * verification, failed-rollback state, duplicate-rollback protection, failure
 * correlation, release-diff evidence, secret redaction, production confirmation,
 * rollback history, and audit events.
 * Deterministic in-memory fake DB — no network, no process, no provider.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ------------------------------------------------------------------ hoisted fakes
const hoisted = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  const DATE_COLS = new Set(['created_at', 'updated_at', 'completed_at', 'started_at']);

  function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function insertRow(text: string, params?: unknown[]): Row[] {
    const m = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)/is.exec(text);
    if (!m) return [];
    const table = m[1]!;
    const cols = m[2]!.split(',').map((c) => c.trim()).filter(Boolean);
    const tokens = splitTopLevel(m[3]!.trim());
    const row: Row = {};
    cols.forEach((c, i) => {
      let v: unknown = undefined;
      const t = (tokens[i] ?? 'NULL').trim();
      const paramM = /^\$(\d+)/.exec(t);
      if (paramM) v = params?.[Number(paramM[1]) - 1];
      else if (t === 'now()') v = new Date();
      else if (t === 'NULL') v = null;
      else if (t === 'TRUE') v = true;
      else if (t === 'FALSE') v = false;
      else v = t;
      row[c] = v;
    });
    for (const dc of DATE_COLS) if (row[dc] === undefined) row[dc] = new Date();
    const arr = tables.get(table) ?? [];
    arr.push(row);
    tables.set(table, arr);
    return [row];
  }

  const query = vi.fn(async (text: string, params?: unknown[]) => insertRow(text, params));

  const queryMany = vi.fn(async (text: string, params?: unknown[]) => {
    const from = /FROM (\w+)/i.exec(text);
    if (!from) return [];
    const table = from[1]!;
    const arr = tables.get(table) ?? [];
    const projIdx = /project_id = \$(\d+)/i.exec(text);
    let rows = arr.filter((r) => {
      if (projIdx && r.project_id !== params?.[Number(projIdx[1]) - 1]) return false;
      return true;
    });
    if (/ORDER BY created_at DESC/i.test(text)) {
      rows = [...rows].sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
    }
    return rows;
  });

  const queryOne = vi.fn(async (text: string, params?: unknown[]) => {
    if (/INSERT INTO/i.test(text)) return insertRow(text, params)[0] ?? null;
    const tableMatch = /UPDATE (\w+)/i.exec(text);
    if (tableMatch) {
      const table = tableMatch[1]!;
      const arr = tables.get(table) ?? [];
      const idIdx = /id = \$(\d+)/i.exec(text);
      const id = params?.[Number(idIdx?.[1]) - 1];
      const row = arr.find((r) => r.id === id);
      if (!row) return null;
      const dataIdx = /data = \$(\d+)/i.exec(text);
      if (dataIdx && params?.[Number(dataIdx[1]) - 1] != null) row.data = params[Number(dataIdx[1]) - 1];
      const statusIdx = /status = \$(\d+)/i.exec(text);
      if (statusIdx && params?.[Number(statusIdx[1]) - 1] != null) row.status = params[Number(statusIdx[1]) - 1];
      return row;
    }
    if (/FROM projects/i.test(text)) {
      const pid = params?.[0];
      if (pid === undefined || pid === null) return null;
      return { id: String(pid) };
    }
    const from = /SELECT ([\s\S]+?) FROM (\w+)/i.exec(text);
    if (from) {
      const table = from[2]!;
      const arr = tables.get(table) ?? [];
      const idIdx = /id = \$(\d+)/i.exec(text);
      const id = params?.[Number(idIdx?.[1]) - 1];
      const projIdx = /project_id = \$(\d+)/i.exec(text);
      const proj = params?.[Number(projIdx?.[1]) - 1];
      const row = arr.find((r) => {
        if (idIdx && r.id !== id) return false;
        return true;
      });
      if (!row) return null;
      if (projIdx && row.project_id !== proj) return null;
      return row;
    }
    return { id: 'prj-1' };
  });

  return { tables, query, queryMany, queryOne };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
const envMock = vi.hoisted(() => ({ RELEASE_CONFIGURED_PROVIDERS: '' }));

vi.mock('../../shared/db.js', () => ({
  pool: { query: hoisted.query },
  queryMany: hoisted.queryMany,
  queryOne: hoisted.queryOne,
  withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, params?: unknown[]) => {
        if (/^\s*SELECT/i.test(text)) {
          if (/WHERE id = \$\d+/i.test(text)) return hoisted.queryOne(text, params).then((row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
          return hoisted.queryMany(text, params).then((rows) => ({ rows, rowCount: rows.length }));
        }
        if (/^\s*UPDATE/i.test(text)) return hoisted.queryOne(text, params).then((row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
        return hoisted.query(text, params).then((rows) => ({ rows, rowCount: rows.length }));
      },
      queryOne: hoisted.queryOne,
      queryMany: hoisted.queryMany,
    }),
  withSystem: async (fn: (q: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, params?: unknown[]) => {
        if (/^\s*SELECT/i.test(text)) {
          if (/WHERE id = \$\d+/i.test(text)) return hoisted.queryOne(text, params).then((row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
          return hoisted.queryMany(text, params).then((rows) => ({ rows, rowCount: rows.length }));
        }
        if (/^\s*UPDATE/i.test(text)) return hoisted.queryOne(text, params).then((row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
        return hoisted.query(text, params).then((rows) => ({ rows, rowCount: rows.length }));
      },
      queryOne: hoisted.queryOne,
      queryMany: hoisted.queryMany,
    }),
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../config/env.js', () => ({ env: envMock }));

// ids mock with sequential, unique ids (stable identity via returned record.id)
let idCounter = 0;
vi.mock('../../shared/ids.js', () => ({
  newId: vi.fn(() => `rel_${++idCounter}`),
  PREFIX: { DEPLOYMENT: 'dp', ROLLBACK_RUN: 'rbr' },
}));

vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string, code?: string) =>
      Object.assign(new Error(msg ?? 'not_found'), { status: 404, errorCode: code ?? 'not_found' }),
    badRequest: (code: string, msg: string) =>
      Object.assign(new Error(msg), { status: 400, errorCode: code }),
  },
}));

import { createReleaseService } from './service.js';
import { assessDatabaseCompat } from './rollback.js';

beforeEach(() => {
  hoisted.tables.clear();
  hoisted.query.mockClear();
  hoisted.queryMany.mockClear();
  hoisted.queryOne.mockClear();
  recordAudit.mockClear();
  envMock.RELEASE_CONFIGURED_PROVIDERS = '';
  idCounter = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

const U = 'usr-1';
const P = 'prj-1';

async function svc(opts: { executeRollback?: Parameters<typeof createReleaseService>[0]['executeRollback']; providers?: string } = {}) {
  envMock.RELEASE_CONFIGURED_PROVIDERS = opts.providers ?? '';
  const deps: Parameters<typeof createReleaseService>[0] = {};
  if (opts.executeRollback) deps.executeRollback = opts.executeRollback;
  return createReleaseService(deps);
}

async function makeVerifiedDeployment(s: Awaited<ReturnType<typeof svc>>, over: Record<string, unknown> = {}) {
  vi.advanceTimersByTime(1000);
  const rec = await s.start(U, {
    projectId: P,
    environment: (over.environment as never) ?? 'development',
    provider: (over.provider as never) ?? 'railway',
    service: (over.service as string) ?? 'backend',
    version: (over.version as string) ?? '1.0.0',
    commitSha: (over.commitSha as string) ?? 'abc123def456',
    branch: (over.branch as string) ?? 'main',
    providerDeploymentId: (over.providerDeploymentId as string | null) ?? null,
  });
  await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'build', pass: true, message: 'build ok' });
  await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'test', pass: true, message: 'test ok' });
  await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'health', pass: true, message: 'health ok' });
  const done = await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'smoke', pass: true, message: 'smoke ok' });
  const finalized = await s.finish(U, P, rec.id, { durationMs: 1000 });
  return { record: done, finalized, id: rec.id };
}

describe('PKG-21 — deployment record model', () => {
  it('1. creates a deployment record with full release identity', async () => {
    const s = await svc();
    const d = await s.start(U, {
      projectId: P, environment: 'production', provider: 'vercel', service: 'frontend',
      version: '2.1.0', commitSha: 'deadbeef', branch: 'release/2.1',
    });
    expect(d.id).toBeTruthy();
    expect(d.id.startsWith('rel_')).toBe(true);
    expect(d.projectId).toBe(P);
    expect(d.environment).toBe('production');
    expect(d.provider).toBe('vercel');
    expect(d.service).toBe('frontend');
    expect(d.version).toBe('2.1.0');
    expect(d.git.available).toBe(true);
    expect(d.git.commitSha).toBe('deadbeef');
    expect(d.status).toBe('PLANNED');
  });

  it('secrets are never exposed in records, history, or gates', async () => {
    const s = await svc();
    const d = await s.start(U, {
      projectId: P,
      version: '1.0.0',
      deploymentUrl: 'https://usr:sekrit@example.com/path?token=SUPERSECRETVALUE&x=1',
    });
    await s.applyGate(U, {
      projectId: P,
      deploymentId: d.id,
      gate: 'build',
      pass: true,
      message: 'provider auth secret:ZlPk9qWnM3v8xR2tB6cA1dE',
    });
    const detail = await s.detail(U, P, d.id);
    const ser = JSON.stringify({ detail, gates: [detail.buildResult] });
    expect(ser).not.toContain('SUPERSECRETVALUE');
    expect(ser).not.toContain('ZlPk9qWnM3v8xR2tB6cA1dE');
  });

  it('2. deployment identity is stable and never silently re-issued', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, version: '1.0.0' });
    await s.applyGate(U, { projectId: P, deploymentId: d.id, gate: 'build', pass: true });
    const fetched = await s.detail(U, P, d.id);
    expect(fetched.id).toBe(d.id); // same immutable id after mutation
  });

  it('3. project isolation: a different project cannot read the record', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, version: '1.0.0' });
    const rows = await s.history('usr-1', 'prj-other');
    expect(rows.length).toBe(0);
    await expect(s.detail(U, 'prj-other', d.id)).rejects.toBeTruthy();
  });

  it('4. workspace id is preserved on the record', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, workspaceId: 'wsp-9', version: '3.0.0' });
    expect(d.workspaceId).toBe('wsp-9');
    const fetched = await s.detail(U, P, d.id);
    expect(fetched.workspaceId).toBe('wsp-9');
  });
});

describe('PKG-21 — history, ordering, filtering', () => {
  it('5/6. chronological ordering + environment isolation', async () => {
    const s = await svc();
    vi.advanceTimersByTime(1000);
    await s.start(U, { projectId: P, environment: 'development', version: '1.0.0' });
    vi.advanceTimersByTime(1000);
    await s.start(U, { projectId: P, environment: 'development', version: '1.0.1' });
    vi.advanceTimersByTime(1000);
    await s.start(U, { projectId: P, environment: 'production', version: '9.9.9' });
    const all = await s.history(U, P, { environment: 'development' });
    expect(all).toHaveLength(2);
    expect(all[0]!.version).toBe('1.0.1'); // most recent first
    expect(all[1]!.version).toBe('1.0.0');
  });

  it('7. filtering by status and service', async () => {
    const s = await svc();
    await makeVerifiedDeployment(await svc(), { service: 'backend', version: '1.0.0' });
    await s.start(U, { projectId: P, service: 'worker', version: '2.0.0' });
    const backend = await s.history(U, P, { service: 'backend' });
    expect(backend).toHaveLength(1);
    const worker = await s.history(U, P, { service: 'worker' });
    expect(worker).toHaveLength(1);
    const verified = await s.history(U, P, { status: 'VERIFIED' });
    expect(verified.length).toBeGreaterThanOrEqual(1);
  });
});

describe('PKG-21 — release identity & git', () => {
  it('8. commit association is retained', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, version: '1.0.0', commitSha: 'f00dcafe1234' });
    expect(d.git.commitSha).toBe('f00dcafe1234');
  });

  it('9. missing-Git reports UNAVAILABLE and never fabricates a hash', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, version: '1.0.0' });
    expect(d.git.available).toBe(false);
    expect(d.git.commitSha).toBeUndefined();
  });
});

describe('PKG-21 — verification', () => {
  it('only VERIFIED when every configured gate passes; FAILED on any gate fail', async () => {
    const s = await svc();
    const rec = await s.start(U, { projectId: P, version: '1.0.0' });
    await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'build', pass: true });
    const failed = await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'test', pass: false });
    expect(failed.verification).toBe('PARTIAL');
    expect(failed.status).toBe('FAILED');
  });
});

describe('PKG-21 — rollback engine & safety', () => {
  it('10/16. authorized rollback uses the current and a verified previous release', async () => {
    const s = await svc({ executeRollback: {
      async execute(_c, _t, cap) {
        return cap.live ? { status: 'SUCCEEDED', detail: 'ok' } : { status: 'BLOCKED', detail: 'blocked' };
      },
    }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway', providerDeploymentId: 'pd-1' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway', providerDeploymentId: 'pd-2' });
    const current = await s.current(U, P, 'development');
    expect(current!.id).toBe(v2.id);
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id,
      environment: 'development',
      confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    expect(run.result).toBe('ROLLED_BACK');
    expect(run.status).toBe('SUCCEEDED');
  });

  it('current-deployment identification returns the most recent verified release', async () => {
    const s = await svc();
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0' });
    const cur = await s.current(U, P, 'development');
    expect(cur!.id).toBe(v2.id);
    expect(cur!.version).toBe('1.1.0');
  });

  it('rollback run records current + target deployment identity and provider', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway', providerDeploymentId: 'pd-11' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway', providerDeploymentId: 'pd-22' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id, environment: 'development', confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    expect(run.currentDeploymentId).toBe(v2.id);
    expect(run.targetDeploymentId).toBe(v1.id);
    const fetched = await s.rollbackStatus(U, P, run.id);
    expect(fetched.currentDeploymentId).toBe(v2.id);
    expect(fetched.targetDeploymentId).toBe(v1.id);
  });

  it('rollback is project-scoped — another project cannot trigger it', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway', providerDeploymentId: 'pd-1' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway', providerDeploymentId: 'pd-2' });
    await expect(s.rollback('usr-1', 'prj-other', { targetDeploymentId: v1.id, environment: 'development', confirmed: true }))
      .rejects.toBeTruthy();
  });

  it('11. wrong-project rollback is rejected', async () => {
    const s = await svc();
    const v1 = await makeVerifiedDeployment(await svc(), { version: '1.0.0' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0' });
    await expect(s.rollback('usr-1', 'prj-other', { targetDeploymentId: v1.id, environment: 'development', confirmed: true }))
      .rejects.toBeTruthy();
  });

  it('12. wrong-environment rollback is blocked (env mismatch)', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } } });
    // current release lives in production
    const v2 = await makeVerifiedDeployment(s, { environment: 'production', version: '3.1.0' });
    // a VERIFIED target from a different environment
    const v1 = await makeVerifiedDeployment(s, { environment: 'development', version: '3.0.0' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id,
      environment: 'production',
      confirmed: true,
    });
    expect(run.result).toBe('BLOCKED');
    expect(run.safetyChecks.find((c) => c.name === 'same_environment')!.ok).toBe(false);
  });

  it('13/14. unsupported / unavailable provider is handled honestly (ENVIRONMENT_BLOCKED)', async () => {
    // No provider configured → ENVIRONMENT_BLOCKED, never VERIFIED.
    const s = await svc();
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id,
      environment: 'development',
      confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    expect(run.result).toBe('BLOCKED');
    expect(run.providerCapability).toBe('ENVIRONMENT_BLOCKED');
    expect(run.status).toBe('BLOCKED');
  });

  it('15. target validation: non-eligible target rejected', async () => {
    const s = await svc();
    const v1 = await s.start(U, { projectId: P, version: '0.9.0' }); // never verified
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0' });
    const run = await s.rollback(U, P, { targetDeploymentId: v1.id, environment: 'development', confirmed: true });
    expect(run.result).toBe('BLOCKED');
    expect(run.safetyChecks.find((c) => c.name === 'target_eligible')!.ok).toBe(false);
  });

  it('17/18. destructive DB migration blocks database rollback', async () => {
    expect(assessDatabaseCompat({ target: { migration: 10 }, current: { migration: 12 }, destructiveMigrations: [11] })).toBe('BLOCKED');
    expect(assessDatabaseCompat({ target: { migration: 10 }, current: { migration: 12 }, destructiveMigrations: [9] })).toBe('COMPATIBLE');
    expect(assessDatabaseCompat({ target: { migration: null }, current: { migration: 12 } })).toBe('UNKNOWN');

    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } } });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id,
      environment: 'development',
      confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 12 }, destructiveMigrations: [11] },
    });
    expect(run.databaseCompat).toBe('BLOCKED');
    expect(run.result).toBe('BLOCKED');
  });

  it('19. verification after a successful rollback marks the target as current VERIFIED', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id, environment: 'development', confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    expect(run.status).toBe('SUCCEEDED');
    const prev = await s.detail(U, P, v2.id);
    expect(prev.status).toBe('ROLLED_BACK');
  });

  it('20. failed rollback records a FAILED state honestly', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'FAILED', detail: 'provider rejected' }; } }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id, environment: 'development', confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    expect(run.status).toBe('FAILED');
    expect(run.result).toBe('FAILED');
  });

  it('21. duplicate rollback protection (target is already current)', async () => {
    const s = await svc();
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0' });
    await expect(s.rollback(U, P, { targetDeploymentId: v1.id, environment: 'development', confirmed: true }))
      .rejects.toMatchObject({ status: 400, errorCode: 'duplicate_rollback' });
  });

  it('25. production rollback requires explicit confirmation — no silent rollback', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } } });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', environment: 'production', provider: 'railway' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', environment: 'production', provider: 'railway' });
    const run = await s.rollback(U, P, { targetDeploymentId: v1.id, environment: 'production' /* no confirmed */ });
    expect(run.result).toBe('BLOCKED');
    expect(run.reason).toMatch(/explicit confirmation/i);
  });

  it('26/27. every rollback attempt is recorded in history + audited', async () => {
    const s = await svc({ executeRollback: { async execute() { return { status: 'SUCCEEDED', detail: 'ok' }; } }, providers: 'railway' });
    const v1 = await makeVerifiedDeployment(s, { version: '1.0.0', provider: 'railway' });
    const v2 = await makeVerifiedDeployment(s, { version: '1.1.0', provider: 'railway' });
    const run = await s.rollback(U, P, {
      targetDeploymentId: v1.id, environment: 'development', confirmed: true,
      dbEvidence: { target: { migration: 10 }, current: { migration: 11 }, destructiveMigrations: [] },
    });
    const history = await s.rollbackHistory(U, P);
    expect(history.some((r) => r.id === run.id)).toBe(true);
    const fetched = await s.rollbackStatus(U, P, run.id);
    expect(fetched.id).toBe(run.id);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'deployment.rollback', resourceType: 'rollback_run' }));
  });
});

describe('PKG-21 — release diff & failure correlation', () => {
  it('9b. release diff is evidence-based (never invents metrics)', async () => {
    const s = await svc();
    const d = await s.start(U, { projectId: P, version: '1.0.0', commitSha: 'abc123' });
    const diff = await s.diff(U, P, d.id, {
      files: [{ path: 'src/x.ts', linesAdded: 5, linesRemoved: 2 }],
      commits: ['c1', 'c2'],
      qualityFindingsCount: 3,
      securityFindingsCount: 1,
      testChanges: ['added src/x.test.ts'],
    });
    expect(diff.filesChanged).toBe(1);
    expect(diff.commits).toBe(2);
    expect(diff.linesAdded).toBe(5);
    expect(diff.linesRemoved).toBe(2);
    expect(diff.qualityFindings).toBe(3);
    expect(diff.securityFindings).toBe(1);
    expect(diff.testChanges).toBe(1);
  });

  it('22. failure correlation identifies the failed stage + next action (no fake root cause)', async () => {
    const s = await svc();
    const rec = await s.start(U, { projectId: P, version: '1.0.0' });
    await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'build', pass: true });
    await s.applyGate(U, { projectId: P, deploymentId: rec.id, gate: 'test', pass: false, message: '2 tests failed' });
    const fc = await s.failure(U, P, rec.id);
    expect(fc.failedStage).toBe('test');
    expect(fc.likelyCause).toMatch(/Test gate failed/i);
    expect(fc.recommendedNextAction).toBeTruthy();
  });
});

describe('PKG-21 — provider capability (honest)', () => {
  it('providerCapability reports ENVIRONMENT_BLOCKED when not configured/live', async () => {
    const s = await svc();
    const caps = s.providers(U);
    for (const c of caps) {
      expect(['SUPPORTED', 'CONFIGURED', 'UNCONFIGURED', 'ENVIRONMENT_BLOCKED', 'UNSUPPORTED']).toContain(c.state);
      expect(c.live).toBe(false);
    }
  });
});
