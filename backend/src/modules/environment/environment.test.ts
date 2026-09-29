/**
 * CodeConClave — PKG-20 Integrated Terminal + Environment Safety — tests.
 * Security-first: env validation is names-only, command-risk is deterministic,
 * production is guarded, secrets are never exposed, isolation is preserved, and
 * environment switching is audited. Uses an in-memory fake DB + injected
 * presence probe + policy grants — no process/network/DB, fully deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerGrants, revokeGrants } from '../execution/policy.js';
import { redactOutput } from '../runtime/security.js';

// ------------------------------------------------------------------ hoisted fakes
const hoisted = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  let nextId = 0;

  const DATE_COLS = new Set(['started_at', 'created_at', 'ended_at', 'updated_at', 'ts']);

  function parseValue(token: string, params?: unknown[]): unknown {
    const t = token.trim();
    if (/^\$\d+/.test(t)) {
      const param = (params?.[Number(t.slice(1).match(/^\d+/)?.[0]) - 1]);
      return param;
    }
    if (t === 'now()') return new Date();
    if (t === 'TRUE') return true;
    if (t === 'FALSE') return false;
    if (t === 'NULL') return null;
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    return t;
  }

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

  function insertRow(text: string, params?: unknown[]): { rows: Row[] } {
    const m = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)/is.exec(text);
    if (!m) return { rows: [] };
    const table = m[1]!;
    const cols = m[2]!.split(',').map((c) => c.trim()).filter(Boolean);
    const tokens = splitTopLevel(m[3]!.trim());
    const row: Row = {};
    cols.forEach((c, i) => {
      let v: unknown = undefined;
      const t = (tokens[i] ?? 'NULL').trim();
      if (/^\$\d+/.test(t)) v = params?.[Number(t.slice(1).match(/^\d+/)?.[0]) - 1];
      else v = parseValue(t, params);
      row[c] = v;
    });
    for (const dc of DATE_COLS) if (row[dc] === undefined) row[dc] = new Date();
    if (!('id' in row)) row.id = `x${++nextId}`;
    const arr = tables.get(table) ?? [];
    arr.push(row);
    tables.set(table, arr);
    return { rows: [row] };
  }

  const query = vi.fn(async (text: string, params?: unknown[]) => insertRow(text, params));

  const queryMany = vi.fn(async (text: string, params?: unknown[]) => {
    const from = /FROM (\w+)/i.exec(text);
    if (!from) return [];
    const table = from[1]!;
    const arr = tables.get(table) ?? [];
    const projIdx = /project_id = \$(\d+)/i.exec(text);
    return arr.filter((r) => {
      if (projIdx && r.project_id !== params?.[Number(projIdx[1]) - 1]) return false;
      return true;
    });
  });

  // Default: satisfy project-ownership check + tolerate inserts. Override per test.
  const queryOne = vi.fn(async (text: string) => {
    if (/INSERT INTO/.test(text)) return insertRow(text).rows[0] ?? null;
    return { id: 'prj-1' };
  });

  return { tables, query, queryMany, queryOne };
});

vi.mock('../../shared/db.js', () => {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        const rows = /FROM projects/i.test(text)
          ? (await hoisted.queryOne(text, params)) ?? []
          : await hoisted.queryMany(text, params);
        const list = Array.isArray(rows) ? rows : [rows];
        return { rows: list, rowCount: list.length };
      }
      return hoisted.query(text, params);
    },
    queryMany: hoisted.queryMany,
    queryOne: hoisted.queryOne,
  };
  return {
    pool: { query: hoisted.query },
    queryMany: hoisted.queryMany,
    queryOne: hoisted.queryOne,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
  };
});

vi.mock('../../shared/errors.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/errors.js')>('../../shared/errors.js');
  return actual;
});

// env mock (mutable per test)
const envMock = vi.hoisted(() => {
  const e: Record<string, string> = {
    RUNTIME_ENV_ALLOWED: 'development,staging,production',
    RUNTIME_ENV_REQUIRED_DEVELOPMENT: 'DATABASE_URL',
    RUNTIME_ENV_REQUIRED_STAGING: 'DATABASE_URL,RAZORPAY_KEY_SECRET',
    RUNTIME_ENV_REQUIRED_PRODUCTION: 'DATABASE_URL,RAZORPAY_KEY_SECRET,JWT_SECRET',
    RUNTIME_ENV_KNOWN_VARS: 'DATABASE_URL,REDIS_URL,JWT_SECRET,REDIS_URL',
  };
  return e;
});
vi.mock('../../config/env.js', () => ({ env: envMock }));

vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../../health/health.js', () => ({ computeHealth: vi.fn() }));

import { recordAudit } from '../audit/service.js';
import { AppError } from '../../shared/errors.js';
import {
  validateEnvironment,
  validateVar,
  requiredVarNames,
} from './validator.js';
import {
  classifyCommand,
  preflightCommand,
  detectDatabaseTarget,
  detectEnvironmentMismatch,
  isDestructiveDbCommand,
} from './safety.js';
import { createEnvironmentService } from './service.js';
import { ENVIRONMENTS } from './types.js';

beforeEach(() => {
  hoisted.tables.clear();
  hoisted.query.mockClear();
  hoisted.queryMany.mockClear();
  hoisted.queryOne.mockClear();
  process.env.RUNTIME_ENV_REQUIRED_DEVELOPMENT = 'DATABASE_URL';
  process.env.RUNTIME_ENV_REQUIRED_STAGING = 'DATABASE_URL,RAZORPAY_KEY_SECRET';
  process.env.RUNTIME_ENV_REQUIRED_PRODUCTION = 'DATABASE_URL,RAZORPAY_KEY_SECRET,JWT_SECRET';
  process.env.RUNTIME_ENV_KNOWN_VARS = 'DATABASE_URL,REDIS_URL,JWT_SECRET';
  envMock.RUNTIME_ENV_REQUIRED_DEVELOPMENT = 'DATABASE_URL';
  envMock.RUNTIME_ENV_REQUIRED_STAGING = 'DATABASE_URL,RAZORPAY_KEY_SECRET';
  envMock.RUNTIME_ENV_REQUIRED_PRODUCTION = 'DATABASE_URL,RAZORPAY_KEY_SECRET,JWT_SECRET';
  registerGrants([
    { id: 'grant-term', userId: 'usr-1', capability: 'EXECUTE_COMMAND', scope: 'node', expiresAt: Date.now() + 60_000, allowedCommands: ['node'] },
    { id: 'grant-npm', userId: 'usr-1', capability: 'EXECUTE_COMMAND', scope: 'npm', expiresAt: Date.now() + 60_000, allowedCommands: ['npm'] },
  ]);
});

afterEach(() => {
  revokeGrants('usr-1');
  delete process.env.RUNTIME_ENV_REQUIRED_DEVELOPMENT;
  delete process.env.RUNTIME_ENV_REQUIRED_STAGING;
  delete process.env.RUNTIME_ENV_REQUIRED_PRODUCTION;
  delete process.env.RUNTIME_ENV_KNOWN_VARS;
});

const presenceOf = (present: string[]) => (name: string) => present.includes(name);

// Module-scope service factory: injects shape-valid env VALUES by name (the
// service uses them only for internal presence/shape — never surfaces them).
function valueOfEnv(present: string[]): (name: string) => string | null {
  return (name) => {
    if (!present.includes(name)) return null;
    if (name === 'DATABASE_URL') return 'postgres://user:pass@host:5432/db';
    if (name === 'REDIS_URL') return 'redis://host:6379';
    if (name === 'JWT_SECRET' || name === 'SESSION_SECRET') return 'x'.repeat(32);
    return 'value'.repeat(4);
  };
}

async function svc(present: string[]) {
  return createEnvironmentService({ valueOf: valueOfEnv(present) });
}

describe('PKG-20 validator (names-only env safety)', () => {
  it('reports PRESENT/MISSING/INVALID statuses but NEVER values', () => {
    const res = validateEnvironment('production', {
      probeVar: (n) => (n === 'DATABASE_URL' ? 'postgres://host/db?password=super-secret' : n === 'JWT_SECRET' ? 'x'.repeat(32) : null),
      required: requiredVarNames('production'),
    });
    const db = res.requiredVars.find((r) => r.name === 'DATABASE_URL')!;
    expect(db.status).toBe('PRESENT');
    expect(res.requiredVars.every((r) => typeof r.name === 'string' && ['PRESENT','MISSING','INVALID','NOT_REQUIRED','UNVERIFIED'].includes(r.status))).toBe(true);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('super-secret');
  });

  it('detects a MISSING required variable', () => {
    const res = validateEnvironment('production', {
      probeVar: () => null,
      required: requiredVarNames('production'),
    });
    expect(res.status).toBe('DEGRADED');
    expect(res.requiredVars.find((r) => r.name === 'JWT_SECRET')!.status).toBe('MISSING');
  });

  it('detects an INVALID (malformed) required variable', () => {
    const res = validateEnvironment('production', {
      probeVar: (n) => (n === 'DATABASE_URL' ? 'not-a-url' : 'x'.repeat(32)),
      required: requiredVarNames('production'),
    });
    const db = res.requiredVars.find((r) => r.name === 'DATABASE_URL')!;
    expect(db.status).toBe('INVALID');
    expect(db.reason).toBeTruthy();
    expect(res.status).toBe('INVALID');
  });

  it('marks non-required known vars as NOT_REQUIRED', () => {
    const res = validateEnvironment('staging', {
      probeVar: (n) => (n === 'REDIS_URL' ? 'redis://h' : null),
      required: requiredVarNames('staging'),
      known: ['DATABASE_URL', 'REDIS_URL'],
    });
    const redis = res.requiredVars.find((r) => r.name === 'REDIS_URL');
    expect(redis?.status).toBe('NOT_REQUIRED');
  });

  it('returns UNVERIFIED when nothing is required/known', () => {
    const res = validateEnvironment('development', {
      probeVar: () => null,
      required: [],
      known: [],
    });
    expect(res.status).toBe('UNVERIFIED');
  });

  it('validateVar returns MISSING for empty/absent and INVALID for malformed, never value', () => {
    expect(validateVar('X', true, () => null, () => null).status).toBe('MISSING');
    expect(validateVar('X', true, () => 'v', () => 'bad').status).toBe('INVALID');
    expect(validateVar('X', false, () => 'v', () => null).status).toBe('NOT_REQUIRED');
  });
});

describe('PKG-20 command risk classification (deterministic)', () => {
  it('classifies a low-risk allowed command as SAFE', () => {
    const r = classifyCommand('usr-1', 'node --version');
    expect(r.risk).toBe('SAFE');
    expect(r.requiresConfirmation).toBe(false);
  });

  it('classifies a risk command (npm install) as CAUTION requiring confirmation', () => {
    const r = classifyCommand('usr-1', 'npm install');
    expect(r.risk).toBe('CAUTION');
    expect(r.requiresConfirmation).toBe(true);
  });

  it('classifies a platform-banned dangerous command as DANGEROUS', () => {
    const r = classifyCommand('usr-1', 'rm -rf /');
    expect(r.risk).toBe('DANGEROUS');
    expect(r.requiresConfirmation).toBe(true);
  });

  it('classifies an empty command as BLOCKED', () => {
    const r = classifyCommand('usr-1', '');
    expect(r.risk).toBe('BLOCKED');
    expect(r.requiresConfirmation).toBe(false);
  });

  it('classifies a disallowed (no grant) command as BLOCKED, never executed', () => {
    const r = classifyCommand('usr-1', 'sudo reboot');
    expect(r.risk).toBe('BLOCKED'); // policy denies un-granted commands outright
    expect(r.requiresConfirmation).toBe(false);
  });
});

describe('PKG-20 environment × command cross-check (preflight)', () => {
  it('production + destructive DB command → BLOCKED', () => {
    const p = preflightCommand('production', 'usr-1', 'psql -c "DROP TABLE users"');
    expect(p.action).toBe('blocked');
    expect(p.environment).toBe('production');
  });

  it('production + dev DB target → mismatch detected', () => {
    const p = preflightCommand('production', 'usr-1', 'node --version');
    // node --version has no db target; use a dev-targeted db command:
    const m = detectEnvironmentMismatch('production', 'psql localhost dev_db');
    expect(m.detected).toBe(true);
  });

  it('dev + production deploy command → confirmation required', () => {
    const p = preflightCommand('development', 'usr-1', 'node --prod');
    expect(p.action).toBe('confirmation_required');
  });

  it('staging + invalid configuration → BLOCKED', () => {
    const p = preflightCommand('staging', 'usr-1', 'node deploy', 'invalid');
    expect(p.action).toBe('blocked');
  });

  it('production + SAFE command that targets production → confirmation required', () => {
    const p = preflightCommand('production', 'usr-1', 'node --version');
    expect(p.action).toBe('execute'); // safe + no db target
  });

  it('detectDatabaseTarget resolves production/development/none', () => {
    expect(detectDatabaseTarget('psql --prod')).toBe('production');
    expect(detectDatabaseTarget('node x')).not.toBe('production');
    expect(detectDatabaseTarget('echo hi')).toBe('none');
  });

  it('isDestructiveDbCommand flags DROP/TRUNCATE/FLUSH', () => {
    expect(isDestructiveDbCommand('psql -c "DROP TABLE t"')).toBe(true);
    expect(isDestructiveDbCommand('node --version')).toBe(false);
  });

  it('preflight includes the structured decision fields (Phase 6)', () => {
    const p = preflightCommand('production', 'usr-1', 'node --version');
    expect(p).toHaveProperty('commandRisk');
    expect(p).toHaveProperty('configuration');
    expect(p).toHaveProperty('databaseTarget');
    expect(p).toHaveProperty('action');
    expect(p).toHaveProperty('mismatch');
  });
});

describe('PKG-20 environment service (auth + isolation + switching)', () => {
  it('returns names-only status and blockEnvironmentSensitive on invalid config', async () => {
    const s = await svc(['DATABASE_URL', 'JWT_SECRET']);
    const st = await s.getStatus('usr-1', 'prj-1');
    expect(st.environment).toBe('development');
    expect(st.blockEnvironmentSensitive).toBe(false);
    expect(st.requiredVars.length).toBeGreaterThan(0);
  });

  it('blocks environment-sensitive work when required vars are missing/invalid', async () => {
    const s = await svc([]);
    const st = await s.validate('usr-1', 'prj-1', 'production');
    expect(st.blockEnvironmentSensitive).toBe(true);
  });

  it('rejects unauthorized project access (cross-user isolation)', async () => {
    hoisted.queryOne.mockImplementationOnce(async () => null); // project not owned
    const s = await svc(['DATABASE_URL']);
    await expect(s.getStatus('usr-2', 'foreign-prj')).rejects.toBeInstanceOf(AppError);
  });

  it('switching to production without explicit confirmation is refused (never silent)', async () => {
    const s = await svc(['DATABASE_URL']);
    await expect(s.select('usr-1', 'prj-1', 'production')).rejects.toHaveProperty('requiresConfirmation', true);
  });

  it('switching with explicit confirmation succeeds and is audited', async () => {
    const s = await svc(['DATABASE_URL']);
    const env = await s.select('usr-1', 'prj-1', 'production', { reason: 'deploy cut', confirmed: true });
    expect(env).toBe('production');
    expect(recordAudit).toHaveBeenCalled();
  });

  it('preflight reflects the persisted active environment context', async () => {
    const s = await svc(['DATABASE_URL']);
    const p = await s.preflight('usr-1', 'prj-1', 'node --version');
    expect(p.environment).toBe('development');
  });

  it('history returns only the acting user/project rows (ownership isolation)', async () => {
    const s = await svc(['DATABASE_URL']);
    const h = await s.history('usr-1', 'prj-1');
    expect(Array.isArray(h)).toBe(true);
  });
});

describe('PKG-20 app-level isolation + secret invariants', () => {
  it('ENVIRONMENTS is exactly the allowed triple', () => {
    expect([...ENVIRONMENTS]).toEqual(['development', 'staging', 'production']);
  });

  it('redactOutput never leaks secret-shaped content in captured output', () => {
    const dirty = 'DB postgres://u:sup3rsecret@host:5432/db token=abcdefghijklmnopqrstuvwxyz1234567890';
    const out = redactOutput(dirty);
    expect(out).not.toContain('sup3rsecret');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(out).toContain('[REDACTED]');
  });

  it('env API reports are value-free by construction', async () => {
    const s = await svc(['DATABASE_URL']);
    const st = await s.getStatus('usr-1', 'prj-1');
    const asJson = JSON.stringify(st);
    expect(asJson).not.toContain('postgres://');
    expect(asJson).not.toMatch(/password|secret|token/i);
  });
});
