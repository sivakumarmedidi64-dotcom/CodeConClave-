/**
 * CodeConClave — Live Preview REAL build proof (Phase C).
 *
 * Runs the ACTUAL preview pipeline — `requestBuild` → real `runBuild` child
 * process in a real fixture project → real build-log capture → READY/ERROR
 * transitions → `previewContent` serving the built bytes with CSP headers.
 *
 * Real: child process spawn, filesystem I/O, log streaming, state machine.
 * Mocked: ONLY the Postgres query layer (in-memory rows executing the same
 * statements) plus audit/notify/snapshots — no database exists in this
 * environment. PG-backed persistence of these rows is therefore NOT proven
 * here (stated in the final report); everything the service computes, spawns,
 * logs, and serves IS real.
 *
 * Skips honestly (no fake pass) when the current Node binary path contains
 * whitespace, because the service splits the build command on whitespace.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = vi.hoisted(() => {
  interface Row {
    id: string; owner_id: string; project_id: string; state: string;
    build_log: string[]; error: string | null; task_id: string | null; version: number;
  }
  const state: { rows: Row[] } = { rows: [] };
  const byProject = (p: string) => state.rows.find((r) => r.project_id === p);
  const byId = (id: string) => state.rows.find((r) => r.id === id);
  const query = async (text: string, params: unknown[] = []) => {
    const p = params as Array<{ toString(): string } & string>;
    if (text.includes('FROM projects')) return { rows: [{ id: String(params[0]) }], rowCount: 1 };
    if (text.startsWith('INSERT INTO preview_sessions')) {
      if (!byProject(String(params[2]))) {
        state.rows.push({
          id: String(params[0]), owner_id: String(params[1]), project_id: String(params[2]),
          state: String(params[3]), build_log: [], error: null, task_id: null, version: 0,
        });
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM preview_sessions WHERE project_id')) return { rows: byProject(String(params[0])) ? [byProject(String(params[0]))] : [], rowCount: 0 };
    if (text.includes('FROM preview_sessions WHERE id')) return { rows: byId(String(params[0])) ? [byId(String(params[0]))] : [], rowCount: 0 };
    if (text.includes('build_log = build_log ||')) {
      const row = byId(String(params[0]));
      if (row) row.build_log.push(...(JSON.parse(String(params[1])) as string[]));
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('SET state = $2, task_id = $3')) {
      const row = byProject(String(params[0]));
      if (row) {
        row.state = String(params[1]);
        row.task_id = (params[2] as string | null) ?? null;
        row.error = null;
        row.build_log = JSON.parse(String(params[3])) as string[];
        row.version += 1;
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('SET state = $2, error = $3 WHERE id')) {
      const row = byId(String(params[0]));
      if (row) {
        row.state = String(params[1]);
        row.error = String(params[2]);
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('SET state = $2, error = NULL WHERE id')) {
      const row = byId(String(params[0]));
      if (row) {
        row.state = String(params[1]);
        row.error = null;
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('SET state = $2 WHERE id')) {
      const row = byId(String(params[0]));
      if (row) row.state = String(params[1]);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const wrap = (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query });
  return {
    state,
    pool: { query },
    queryMany: async (t: string, x: unknown[] = []) => (await query(t, x)).rows,
    queryOne: async (t: string, x: unknown[] = []) => (await query(t, x)).rows[0] ?? null,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => wrap(fn),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => wrap(fn),
  };
});
vi.mock('../../shared/db.js', () => db);
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => ({})) }));
vi.mock('../notifications/service.js', () => ({ notify: vi.fn(async () => ({})), notifyUser: vi.fn(async () => ({})) }));
vi.mock('./snapshots.js', () => ({ capturePreviewSnapshot: vi.fn(async () => ({})) }));

import { requestBuild, previewContent, getPreview } from './service.js';
import { env } from '../../config/env.js';

const CAN_RUN_REAL_BUILD = !/\s/.test(process.execPath);

const SYSWOW_CMD = 'C:\\Windows\\SysWOW64\\cmd.exe';
let savedComSpec: string | undefined;

const SHELL_OK =
  process.platform !== 'win32' ||
  (Boolean(process.env.ComSpec) && existsSync(String(process.env.ComSpec))) ||
  existsSync(SYSWOW_CMD);

/**
 * This sandbox keeps cmd.exe in SysWOW64 while ComSpec points at the absent
 * System32 copy (the service's `shell: true` follows ComSpec). Point the TEST
 * process at the working copy when needed — service code is untouched; on a
 * normal box the default ComSpec already resolves and nothing changes.
 */
function ensureShell(): boolean {
  if (process.platform !== 'win32') return true;
  const def = process.env.ComSpec;
  if (def && existsSync(def)) return true;
  if (existsSync(SYSWOW_CMD)) {
    savedComSpec = def;
    process.env.ComSpec = SYSWOW_CMD;
    return true;
  }
  return false;
}

let projectsRoot = '';
let outRoot = '';

function setPreviewEnv(command: string): void {
  Object.defineProperty(env, 'PREVIEW_BUILD_ENABLED', { value: 'true', configurable: true });
  Object.defineProperty(env, 'PREVIEW_BUILD_COMMAND', { value: command, configurable: true });
  Object.defineProperty(env, 'PREVIEW_PROJECTS_ROOT', { value: projectsRoot, configurable: true });
  Object.defineProperty(env, 'PREVIEW_OUTPUT_DIR', { value: outRoot, configurable: true });
}

function makeProject(projectId: string, script: string): void {
  const dir = join(projectsRoot, projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'build.cjs'), script, 'utf8');
}

const OK_SCRIPT = `const fs=require('fs');const path=require('path');
const out=process.env.CC_PREVIEW_OUT;
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html><body><div id="marker">live-preview-proof-marker</div></body></html>');
console.log('build script says hello');`;
const FAIL_SCRIPT = `console.error('simulated compile error');process.exit(3);`;

async function waitFor(projectId: string, states: string[], timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const session = await getPreview('u1', projectId);
    if (states.includes(session.state)) return session.state;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${states.join('/')} (still ${session.state})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(!CAN_RUN_REAL_BUILD || !SHELL_OK)('live preview REAL build pipeline', () => {
  beforeAll(() => {
    ensureShell();
    projectsRoot = mkdtempSync(join(tmpdir(), 'cc-preview-root-'));
    outRoot = mkdtempSync(join(tmpdir(), 'cc-preview-out-'));
    makeProject('prj-live-ok', OK_SCRIPT);
    makeProject('prj-live-fail', FAIL_SCRIPT);
  });

  afterAll(() => {
    if (savedComSpec !== undefined) {
      if (savedComSpec) process.env.ComSpec = savedComSpec;
      else delete process.env.ComSpec;
      savedComSpec = undefined;
    }
    for (const dir of [projectsRoot, outRoot]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('builds a real project, reaches READY, and serves the built bytes with CSP', async () => {
    process.env.CC_PREVIEW_OUT = join(outRoot, 'prj-live-ok');
    setPreviewEnv(`${process.execPath} build.cjs`);
    const started = await requestBuild('u1', 'prj-live-ok');
    expect(['BUILDING', 'UPDATING']).toContain(started.state);
    expect(await waitFor('prj-live-ok', ['READY'])).toBe('READY');
    const session = await getPreview('u1', 'prj-live-ok');
    expect(session.error).toBeNull();
    expect(session.version).toBeGreaterThanOrEqual(1);
    // Real build log: the command echo plus the script's own stdout line.
    expect(session.build_log.some((l) => l.includes('build.cjs'))).toBe(true);
    expect(session.build_log.some((l) => l.includes('build script says hello'))).toBe(true);
    const content = await previewContent('u1', 'prj-live-ok');
    expect(content).not.toBeNull();
    expect(content!.html).toContain('live-preview-proof-marker');
    expect(content!.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('marks ERROR with the real exit code when the build command fails', async () => {
    process.env.CC_PREVIEW_OUT = join(outRoot, 'prj-live-fail');
    setPreviewEnv(`${process.execPath} build.cjs`);
    // Point the failing project at the failing script via its own project dir.
    await requestBuild('u1', 'prj-live-fail');
    expect(await waitFor('prj-live-fail', ['ERROR'])).toBe('ERROR');
    const session = await getPreview('u1', 'prj-live-fail');
    expect(session.error).toContain('exit 3');
    expect(session.error).toContain('simulated compile error');
    // A failed build honestly serves nothing.
    expect(await previewContent('u1', 'prj-live-fail')).toBeNull();
  });
});
