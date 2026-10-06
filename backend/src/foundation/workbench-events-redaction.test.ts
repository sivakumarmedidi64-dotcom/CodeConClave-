/**
 * CodeConClave — Workbench support contracts: terminal secret redaction
 * before persistence AND the execution -> runtime event bridge (task/coworker
 * transitions land on the project-scoped SSE bus). Tests drive the real
 * modules with a stubbed db so no query escapes the SUT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: rows ? rows.length : state.rows.length };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import { appendTerminalHistory, terminalHistoryLines } from '../modules/terminal/store.js';
import { redactSecrets } from '../modules/secretGuard/patterns.js';
import { subscribeRuntime } from '../modules/runtime/events.js';
import { emitTaskRuntime, emitCoworkerRuntime } from '../modules/execution/events.js';

const USER_ID = 'usr_wb1';
const SESSION_ID = 'tsm_wb1';
const TASK_ID = 'tsk_wb1';
const RUN_ID = 'cwr_wb1';

const PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\n-----END RSA PRIVATE KEY-----';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
});

describe('terminal history persistence', () => {
  it('persists secrets REDACTED (never stores raw material)', async () => {
    db.state.resolve = () => null; // insert only; no session rows needed
    const raw = `MENT-EC2 key=AKIAIOSFODNN7EXAMPLE token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123
postgres://admin:s3cret@db.example.com:5432/app`;
    await appendTerminalHistory(USER_ID, SESSION_ID, 'stdout', raw);

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO terminal_history'));
    expect(insert).toBeDefined();
    const stored = String(insert!.params[3]);
    expect(stored).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(stored).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123');
    expect(stored).not.toContain('s3cret@db.example.com');
    expect(stored).toContain('[REDACTED:');
  });

  it('round-trips through the read path already redacted', async () => {
    const stored = redactSecrets(`token ${PRIVATE_KEY}\n`);
    db.state.resolve = () => [
      { id: 'h1', channel: 'stdout', text: stored.slice(0, 65536), seq: 1, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    const lines = await terminalHistoryLines(USER_ID, SESSION_ID, 10);
    expect(lines[0]!.text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(lines[0]!.text).toContain('[REDACTED:Private key]');
  });

  it('persists an input line with every secret masked', async () => {
    const raw = 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';
    await appendTerminalHistory(USER_ID, SESSION_ID, 'input', raw);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO terminal_history'));
    expect(insert).toBeDefined();
    const stored = String(insert!.params[3]);
    expect(stored).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(stored).toContain('[REDACTED:');
  });
});

describe('execution -> runtime event bridge', () => {
  it('emits a task transition onto the project event stream', async () => {
    db.state.resolve = () => [{ project_id: 'proj_wb1' }];
    const seen: unknown[] = [];
    const unsubscribe = subscribeRuntime('proj_wb1', (e) => seen.push(e));
    try {
      await emitTaskRuntime(TASK_ID, 'RUNNING');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ type: 'task', id: TASK_ID, projectId: 'proj_wb1', status: 'RUNNING' });
    } finally {
      unsubscribe();
    }
  });

  it('emits a coworker run transition onto the owning project stream', async () => {
    db.state.resolve = () => [{ project_id: 'proj_wb1' }];
    const seen: unknown[] = [];
    const unsubscribe = subscribeRuntime('proj_wb1', (e) => seen.push(e));
    try {
      await emitCoworkerRuntime(RUN_ID, 'COMPLETED');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ type: 'coworker', runId: RUN_ID, projectId: 'proj_wb1', state: 'COMPLETED' });
    } finally {
      unsubscribe();
    }
  });

  it('is a silent no-op when the row no longer exists', async () => {
    db.state.resolve = () => [];
    const seen: unknown[] = [];
    const unsubscribe = subscribeRuntime('proj_wb1', (e) => seen.push(e));
    try {
      await emitTaskRuntime(TASK_ID, 'COMPLETED');
      await emitCoworkerRuntime(RUN_ID, 'FAILED');
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

describe('redaction helper boundary', () => {
  it('keeps short innocuous values while masking long secrets', () => {
    expect(redactSecrets('npm install react')).toBe('npm install react');
    expect(redactSecrets('api_key=GsOdVEhGcOIz7nRkbDNZZD47y5idETb1QLqexGszBkI4mO2NBc2kExLj9nv9CpWJvN')).toContain('[REDACTED');
  });
});