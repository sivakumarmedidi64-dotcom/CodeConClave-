/**
 * CodeConClave — PKG-19 Browser + Runtime Development — tests.
 * Covers execution lifecycle, policy blocking, workspace isolation, secret
 * redaction, background tasks, console/network capture (evidence-only honest
 * boundary), verification statuses, smoke foundation, and frontend/backend
 * correlation. Uses an in-memory fake DB and injected fakes for the process
 * runner and probes — no process/network/DB needed, fully deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ hoisted fakes
const hoisted = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  let nextId = 0;

  function storeTable(table: string, row: Row): void {
    const arr = tables.get(table) ?? [];
    arr.push(row);
    tables.set(table, arr);
  }

  const DATE_COLS = new Set(['started_at', 'created_at', 'ended_at', 'ts']);

  function parseValue(token: string, params?: unknown[]): unknown {
    const t = token.trim();
    if (/^\$\d+$/.test(t)) return params?.[Number(t.slice(1)) - 1];
    if (t === 'now()') return new Date();
    if (t === 'TRUE') return true;
    if (t === 'FALSE') return false;
    if (t === 'NULL') return null;
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    return t;
  }

  // Split a VALUES (...) inner string on top-level commas.
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

  const query = vi.fn(async (text: string, params?: unknown[]) => {
    const insert = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)/is.exec(text);
    if (insert) {
      const table = insert[1]!;
      const cols = insert[2]!.split(',').map((c) => c.trim()).filter(Boolean);
      const valuesRaw = insert[3]!.trim();
      // Values end at the section of SQL that starts a RETURNING/clause; take up to the last ')' boundary.
      const valuesPart = valuesRaw;
      const tokens = splitTopLevel(valuesPart);
      const row: Row = {};
      cols.forEach((c, i) => {
        row[c] = parseValue(tokens[i] ?? 'NULL', params);
      });
      for (const dc of DATE_COLS) {
        if (row[dc] === undefined) row[dc] = new Date();
      }
      if (!('id' in row)) row.id = `x${++nextId}`;
      storeTable(table, row);
      return { rows: [row] };
    }
    const update = /UPDATE (\w+)\s+SET\s+(.+?)\s+WHERE id = \$(\d+)/is.exec(text);
    if (update) {
      const table = update[1]!;
      const idParam = Number(update[3]);
      const idVal = params?.[idParam - 1];
      const arr = tables.get(table) ?? [];
      const target = arr.find((r) => r.id === idVal);
      if (target) {
        for (const clause of update[2]!.split(',')) {
          const m = /^(\w+)\s*=\s*(.+)$/.exec(clause.trim());
          if (m) target[m[1]!] = parseValue(m[2]!, params);
        }
        for (const dc of DATE_COLS) {
          if (target[dc] === undefined) target[dc] = new Date();
        }
      }
      return { rows: [] };
    }
    const del = /DELETE FROM (\w+)/i.exec(text);
    if (del) {
      tables.set(del[1]!, []);
      return { rows: [] };
    }
    return { rows: [] };
  });

  const queryMany = vi.fn(async (text: string, params?: unknown[]) => {
    const from = /FROM (\w+)/i.exec(text);
    if (!from) return [];
    const table = from[1]!;
    const arr = tables.get(table) ?? [];
    const idIdx = /WHERE id = \$(\d+)/i.exec(text);
    const projIdx = /project_id = \$(\d+)/i.exec(text);
    return arr.filter((r) => {
      if (idIdx && r.id !== params?.[Number(idIdx[1]) - 1]) return false;
      if (projIdx && r.project_id !== params?.[Number(projIdx[1]) - 1]) return false;
      return true;
    });
  });

  const queryOne = vi.fn(async () => ({ id: 'prj-1' }));

  return { tables, query, queryMany, queryOne };
});

vi.mock('../../shared/db.js', () => ({
  pool: { query: hoisted.query },
  queryMany: hoisted.queryMany,
  queryOne: hoisted.queryOne,
  withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, params?: unknown[]) => {
        const rowsPromise = /^\s*SELECT/i.test(text) ? hoisted.queryMany(text, params) : hoisted.query(text, params);
        return rowsPromise.then((rows) => ({ rows, rowCount: rows.length }));
      },
      queryOne: hoisted.queryOne,
      queryMany: hoisted.queryMany,
    }),
  withSystem: async (fn: (q: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, params?: unknown[]) => {
        const rowsPromise = /^\s*SELECT/i.test(text) ? hoisted.queryMany(text, params) : hoisted.query(text, params);
        return rowsPromise.then((rows) => ({ rows, rowCount: rows.length }));
      },
      queryOne: hoisted.queryOne,
      queryMany: hoisted.queryMany,
    }),
}));

vi.mock('../../shared/errors.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/errors.js')>('../../shared/errors.js');
  return actual;
});

// env mock (mutable per test)
const envMock = vi.hoisted(() => {
  const e: Record<string, string> = {
    PREVIEW_PROJECTS_ROOT: '',
    PREVIEW_BUILD_ENABLED: 'false',
    PREVIEW_BUILD_COMMAND: '',
    AIOS_SANDBOX_ALLOWED_COMMANDS: '',
    AIOS_SANDBOX_TIMEOUT_MS: '30000',
    RUNTIME_VERIFY_ENABLED: 'false',
    RUNTIME_VERIFY_URLS: '',
    RUNTIME_HOST: '',
    RUNTIME_PORT: '',
    RUNTIME_SMOKE_CONFIG: '',
    RUNTIME_SMOKE_BASE_URL: '',
  };
  return e;
});
vi.mock('../../config/env.js', () => ({ env: envMock }));

vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../../health/health.js', () => ({ computeHealth: vi.fn() }));
vi.mock('../preview/service.js', () => ({
  getPreview: vi.fn(async () => ({ state: 'NOT_CONFIGURED' })),
  previewConfigured: vi.fn(() => false),
}));

import { registerGrants, revokeGrants } from '../execution/policy.js';
import { defaultRunner } from './runner.js';
import { realProbe } from './probes.js';
import { runtimeExecutionsEngine, RuntimeExecutionsEngine } from './executions.js';
import { RuntimeBackgroundEngine, runtimeBackgroundEngine } from './background.js';
import { runtimeCaptureEngine } from './capture.js';
import { RuntimeVerificationEngine } from './verification.js';
import { RuntimeSmokeEngine } from './smoke.js';
import { runtimeCorrelationEngine } from './correlation.js';
import { runtimeCapabilities } from './service.js';
import { redactOutput } from './security.js';
import { AppError } from '../../shared/errors.js';

const tmpRoot = path.join(tmpdir(), `codeconclave-pkg19-${process.pid}`);

let workspaces: string[] = [];
async function makeWorkspace(projectId: string): Promise<string> {
  const dir = path.join(tmpRoot, projectId);
  await mkdir(dir, { recursive: true });
  workspaces.push(dir);
  return dir;
}

beforeEach(async () => {
  await mkdir(tmpRoot, { recursive: true });
  envMock.PREVIEW_PROJECTS_ROOT = tmpRoot;
  envMock.AIOS_SANDBOX_ALLOWED_COMMANDS = 'node';
  envMock.AIOS_SANDBOX_TIMEOUT_MS = '30000';
  hoisted.tables.clear();
  hoisted.tables.set('projects', [{ id: 'prj-1' }]);
  hoisted.query.mockClear();
  hoisted.queryMany.mockClear();
  hoisted.queryOne.mockClear();
  registerGrants([
    { id: 'grant-1', userId: 'usr-1', capability: 'EXECUTE_COMMAND', scope: 'node', expiresAt: Date.now() + 60_000, allowedCommands: ['node'] },
  ]);
});

afterEach(async () => {
  revokeGrants('usr-1');
  envMock.PREVIEW_PROJECTS_ROOT = '';
  envMock.AIOS_SANDBOX_ALLOWED_COMMANDS = '';
  for (const w of workspaces) {
    await rm(w, { recursive: true, force: true }).catch(() => undefined);
  }
  workspaces = [];
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function fakeRunner(result?: Partial<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; killed: boolean; durationMs: number }>) {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls += 1;
    return {
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
      timedOut: result?.timedOut ?? false,
      killed: result?.killed ?? false,
      durationMs: result?.durationMs ?? 5,
    };
  });
  return { run: fn, getCalls: () => calls };
}

describe('Runtime capabilities (honest report)', () => {
  it('reports anchors F34/F90/F38/F49 and honest readiness', () => {
    const report = runtimeCapabilities();
    expect(report.anchors).toEqual(['F34', 'F90', 'F38', 'F49']);
    expect(report.capabilities).toHaveProperty('executionEnabled');
    expect(report.capabilities).toHaveProperty('browserRuntime');
  });
});

describe('Runtime executions (F34/F90)', () => {
  it('blocks a command by policy when no valid EXECUTE_COMMAND grant', async () => {
    revokeGrants('usr-1');
    await makeWorkspace('prj-1');
    const res = await runtimeExecutionsEngine.execute('usr-1', { projectId: 'prj-1', command: 'node --version' });
    expect(res.status).toBe('BLOCKED');
    expect(res.blocked).toBe(true);
    expect(res.error).toContain('policy');
  });

  it('runs a PASS execution through the injected runner and maps to COMPLETED', async () => {
    await makeWorkspace('prj-1');
    const runner = fakeRunner({ exitCode: 0, stdout: 'v20.0.0' });
    const engine = new RuntimeExecutionsEngine({ run: runner.run }, () => ({ allowed: ['node'], timeoutMs: 30000 }));
    const res = await engine.execute('usr-1', { projectId: 'prj-1', command: 'node --version' });
    expect(runner.getCalls()).toBe(1);
    expect(res.status).toBe('COMPLETED');
    expect(res.command).toBe('node --version');
  });

  it('maps a non-zero exit to FAILED and a time-out to TIMED_OUT', async () => {
    await makeWorkspace('prj-1');
    const failRunner = fakeRunner({ exitCode: 1, stdout: 'boom' });
    const fail = new RuntimeExecutionsEngine({ run: failRunner.run }, () => ({ allowed: ['node'], timeoutMs: 30000 }));
    expect((await fail.execute('usr-1', { projectId: 'prj-1', command: 'node x' })).status).toBe('FAILED');

    const toRunner = fakeRunner({ exitCode: 0, timedOut: true });
    const to = new RuntimeExecutionsEngine({ run: toRunner.run }, () => ({ allowed: ['node'], timeoutMs: 30000 }));
    const res = await to.execute('usr-1', { projectId: 'prj-1', command: 'node x' });
    expect(res.status).toBe('TIMED_OUT');
    expect(res.timedOut).toBe(true);
  });

  it('redacts secrets that appear in captured output', async () => {
    const leaked = `DB=postgres://user:hunter2@host/db\napiKey=sk-abcdefghijklmnop`;
    const redacted = redactOutput(leaked);
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('sk-abcdefghijklmnop');
    expect(redacted).toContain('[REDACTED]');
  });

  it('persists a BLOCKED record when the sandbox allow-list is empty', async () => {
    envMock.AIOS_SANDBOX_ALLOWED_COMMANDS = '';
    await makeWorkspace('prj-1');
    const res = await runtimeExecutionsEngine.execute('usr-1', { projectId: 'prj-1', command: 'node --version' });
    expect(res.status).toBe('BLOCKED');
  });

  it('throws notFound when the user does not own the project', async () => {
    hoisted.tables.set('projects', []);
    await expect(runtimeExecutionsEngine.execute('usr-other', { projectId: 'prj-x', command: 'node --version' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('rejects an empty command with a 400', async () => {
    await makeWorkspace('prj-1');
    await expect(runtimeExecutionsEngine.execute('usr-1', { projectId: 'prj-1', command: '   ' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('Runtime background tasks (F90)', () => {
  it('starts a task and runs it to COMPLETED', async () => {
    await makeWorkspace('prj-1');
    const runner = fakeRunner({ exitCode: 0, stdout: 'built' });
    const engine = new RuntimeBackgroundEngine({ run: runner.run }, () => ({ allowed: ['node'], timeoutMs: 30000 }));
    const started = await engine.start('usr-1', { projectId: 'prj-1', label: 'build', kind: 'BUILD', command: 'node build' });
    expect(['STARTING', 'RUNNING', 'COMPLETED']).toContain(started.status);
    await new Promise((r) => setTimeout(r, 10));
    const done = await engine.get('usr-1', 'prj-1', started.id);
    expect(done.status).toBe('COMPLETED');
  });

  it('records a best-effort STOPPED for a still-running task', async () => {
    await makeWorkspace('prj-1');
    let release: (v: typeof result) => void;
    const gate = new Promise<typeof result>((res) => { release = res; });
    const result = { exitCode: 0 as number | null, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 5 };
    const run = vi.fn(async () => gate);
    const engine = new RuntimeBackgroundEngine({ run }, () => ({ allowed: ['node'], timeoutMs: 30000 }));
    const started = await engine.start('usr-1', { projectId: 'prj-1', label: 'dev', kind: 'DEV_SERVER', command: 'node dev' });
    const stopped = await engine.stop('usr-1', 'prj-1', started.id);
    expect(stopped.status).toBe('STOPPED');
    release!(result);
    await new Promise((r) => setTimeout(r, 5));
  });

  it('blocks a background task missing the sandbox allow-list', async () => {
    envMock.AIOS_SANDBOX_ALLOWED_COMMANDS = '';
    await makeWorkspace('prj-1');
    const res = await runtimeBackgroundEngine.start('usr-1', { projectId: 'prj-1', label: 'x', command: 'node x' });
    expect(res.status).toBe('BLOCKED');
  });
});

describe('Console + network capture boundaries (F38)', () => {
  it('records and lists only-evidence console events', async () => {
    hoisted.queryOne.mockResolvedValue({ id: 'prj-1' });
    const ev = await runtimeCaptureEngine.recordConsole('usr-1', 'prj-1', 'error', 'Cannot read property x', '  at fn (a.js:1:1)');
    expect(ev.level).toBe('error');
    const list = await runtimeCaptureEngine.listConsole('usr-1', 'prj-1');
    expect(list.length).toBe(1);
    expect(list[0]!.message).toContain('Cannot read property');
  });

  it('records network metadata with sensitive query params redacted', async () => {
    hoisted.queryOne.mockResolvedValue({ id: 'prj-1' });
    const ev = await runtimeCaptureEngine.recordNetwork('usr-1', 'prj-1', 'GET', 'https://x.test/api?token=SECRET&a=1', 401, 12, 'req-1');
    expect(ev.method).toBe('GET');
    expect(ev.state).toBe('CLIENT_ERROR');
    expect(ev.status).toBe(401);
    const list = await runtimeCaptureEngine.listNetwork('usr-1', 'prj-1');
    expect(list[0]!.urlPath).not.toContain('SECRET');
  });

  it('surfaces UNAVAILABLE (no evidence) via correlation', async () => {
    const out = await runtimeCorrelationEngine.correlate('usr-1', 'prj-1');
    expect(out.state).toBe('UNAVAILABLE');
    expect(out.findings.length).toBe(0);
  });

  it('derives heuristic correlation findings from captured failures', async () => {
    hoisted.queryOne.mockResolvedValue({ id: 'prj-1' });
    await runtimeCaptureEngine.recordNetwork('usr-1', 'prj-1', 'GET', 'https://x.test/api/orders', 500, 30, 'req-9');
    await runtimeCaptureEngine.recordConsole('usr-1', 'prj-1', 'error', '500 from /api/orders');
    const out = await runtimeCorrelationEngine.correlate('usr-1', 'prj-1');
    expect(out.state).toBe('HEURISTIC');
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings[0]!.state).toBe('HEURISTIC');
  });
});

describe('Runtime verification (F38)', () => {
  it('reports NOT_RUN when verification is disabled', async () => {
    envMock.RUNTIME_VERIFY_ENABLED = 'false';
    const engine = new RuntimeVerificationEngine(realProbe, async () => ({ ok: true, status: 'HEALTHY' }));
    const results = await engine.verify('usr-1', 'prj-1');
    expect(results.some((r) => r.label === 'Backend health' && r.status === 'NOT_RUN')).toBe(true);
  });

  it('reports PASS/FAIL from the backend health probe', async () => {
    envMock.RUNTIME_VERIFY_ENABLED = 'true';
    const ok = new RuntimeVerificationEngine(realProbe, async () => ({ ok: true, status: 'HEALTHY' }));
    const r1 = await ok.verify('usr-1', 'prj-1');
    expect(r1.some((r) => r.label === 'Backend health' && r.status === 'PASS')).toBe(true);

    const bad = new RuntimeVerificationEngine(realProbe, async () => ({ ok: false, status: 'FAILED' }));
    const r2 = await bad.verify('usr-1', 'prj-1');
    expect(r2.some((r) => r.label === 'Backend health' && r.status === 'FAIL')).toBe(true);
  });

  it('reports NOT_RUN for unconfigured targets, never PASS', async () => {
    envMock.RUNTIME_VERIFY_ENABLED = 'true';
    envMock.RUNTIME_VERIFY_URLS = '';
    const engine = new RuntimeVerificationEngine(realProbe, async () => ({ ok: true, status: 'HEALTHY' }));
    const results = await engine.verify('usr-1', 'prj-1');
    const ep = results.find((r) => r.label === 'Configured endpoints');
    expect(ep?.status).toBe('NOT_RUN');
  });
});

describe('Smoke-test foundation', () => {
  it('runs configured checks and aggregates PASS/FAIL', async () => {
    const probe = {
      httpGet: vi.fn(async (u: string) => (u.includes('bad') ? { ok: false, status: 500, error: 'err' } : { ok: true, status: 200 })),
      portOpen: vi.fn(async () => ({ open: true })),
    };
    const engine = new RuntimeSmokeEngine(probe as unknown as typeof realProbe);
    const out = await engine.run('usr-1', 'prj-1', [
      { name: 'home', method: 'GET', url: 'https://x.test/', expectedStatus: 200 },
      { name: 'bad', method: 'GET', url: 'https://x.test/bad', expectedStatus: 200 },
    ]);
    expect(out.summary.status).toBe('FAIL');
    expect(out.results.some((r) => r.name === 'home' && r.status === 'PASS')).toBe(true);
    expect(out.results.some((r) => r.name === 'bad' && r.status === 'FAIL')).toBe(true);
  });

  it('reports UNAVAILABLE when no smoke targets are configured', async () => {
    const engine = new RuntimeSmokeEngine(realProbe);
    const out = await engine.run('usr-1', 'prj-1');
    expect(out.summary.status).toBe('UNAVAILABLE');
  });
});
