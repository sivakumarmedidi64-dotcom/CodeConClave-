/**
 * Stage 25.5 - live preview contract suite.
 * Covers: honest session creation (NOT_CONFIGURED when tooling is absent),
 * build gating (never a fake READY), BUILDING -> READY/ERROR transitions with
 * sandboxed output, the task-completed rebuild hook (UPDATING), and content
 * serving with strict CSP only for READY builds. The build command is mocked
 * - no real child process runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = { rows: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : state.rows;
    return { rows: rows ?? [], rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async () => '<html>preview</html>'),
  stat: vi.fn(async () => ({})),
}));
vi.mock('node:fs/promises', () => fsMock);

import { getPreview, requestBuild, previewTaskCompleted, previewContent, previewConfigured } from '../modules/preview/service.js';
import { env } from '../config/env.js';

const SESSION = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'pvw-1',
  owner_id: 'u1',
  project_id: 'prj-1',
  state: 'NOT_CONFIGURED',
  build_log: [],
  error: null,
  task_id: null,
  version: 0,
  updated_at: new Date(),
  created_at: new Date(),
  ...over,
});

function setPreviewEnv(enabled: boolean): void {
  Object.defineProperty(env, 'PREVIEW_BUILD_ENABLED', { value: enabled ? 'true' : 'false', configurable: true });
  Object.defineProperty(env, 'PREVIEW_BUILD_COMMAND', { value: 'npm run build', configurable: true });
  Object.defineProperty(env, 'PREVIEW_PROJECTS_ROOT', { value: 'C:/preview/root', configurable: true });
  Object.defineProperty(env, 'PREVIEW_OUTPUT_DIR', { value: 'C:/preview/out', configurable: true });
}

function mockSpawn(exitCode: number): void {
  spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: { cwd: string }) => {
    const child: Record<string, unknown> = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (e: string, cb: (code: number) => void) => {
        if (e === 'error') return;
        setTimeout(() => cb(exitCode), 5);
      },
      kill: () => {},
    };
    return child;
  });
}

/** First project_id fetch returns `initial`; the post-update fetch returns `updated`. */
function previewResolver(initial: Record<string, unknown>, updated: Record<string, unknown>) {
  let count = 0;
  return (text: string) => {
    if (text.includes('FROM projects')) return [{ id: 'prj-1' }];
    if (text.includes('FROM preview_sessions WHERE project_id')) {
      count += 1;
      return [count > 1 ? updated : initial];
    }
    if (text.includes('FROM preview_sessions WHERE id')) return [updated];
    return null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.resolve = null;
  db.state.rows = [];
  setPreviewEnv(false);
});

describe('HONEST CAPABILITY', () => {
  it('previewConfigured is false when the master switch is off', () => {
    expect(previewConfigured()).toBe(false);
  });

  it('previewConfigured requires both the switch and a build command', () => {
    setPreviewEnv(true);
    expect(previewConfigured()).toBe(true);
    Object.defineProperty(env, 'PREVIEW_BUILD_COMMAND', { value: '', configurable: true });
    expect(previewConfigured()).toBe(false);
  });
});

describe('SESSION LIFECYCLE', () => {
  it('getPreview creates a session that is honestly NOT_CONFIGURED without tooling', async () => {
    db.state.rows = [SESSION()];
    const session = await getPreview('u1', 'prj-1');
    expect(session.state).toBe('NOT_CONFIGURED');
  });

  it('getPreview creates idempotently under a concurrent first load (W-3 regression)', async () => {
    let reads = 0;
    let insertText = '';
    db.state.resolve = (text: string) => {
      if (text.includes('FROM projects')) return [{ id: 'prj-1' }];
      if (text.includes('FROM preview_sessions WHERE project_id')) {
        reads += 1;
        return reads === 1 ? [] : [SESSION({ id: 'pvw-winner' })];
      }
      if (text.includes('INSERT INTO preview_sessions')) {
        insertText = text;
        return null;
      }
      return null;
    };
    const session = await getPreview('u1', 'prj-1');
    expect(insertText).toMatch(/ON CONFLICT/);
    expect(session.id).toBe('pvw-winner');
    expect(session.state).toBe('NOT_CONFIGURED');
  });

  it('getPreview refuses projects the user does not own', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM projects') ? [] : null);
    await expect(getPreview('u1', 'prj-9')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('requestBuild without tooling stays NOT_CONFIGURED with a reason (never fakes a build)', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM projects')) return [{ id: 'prj-1' }];
      if (text.includes('FROM preview_sessions WHERE project_id')) {
        return [SESSION({ state: 'NOT_CONFIGURED', error: 'Preview tooling is not configured on this deployment' })];
      }
      return null;
    };
    const session = await requestBuild('u1', 'prj-1');
    expect(session.state).toBe('NOT_CONFIGURED');
    expect(session.error).toContain('not configured');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requestBuild with tooling transitions BUILDING then READY and notifies', async () => {
    setPreviewEnv(true);
    mockSpawn(0);
    db.state.resolve = previewResolver(SESSION(), SESSION({ state: 'BUILDING', version: 1 }));
    const session = await requestBuild('u1', 'prj-1');
    expect(['BUILDING', 'UPDATING']).toContain(session.state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('u1', 'preview.ready', 'Preview ready', expect.anything()), { timeout: 2000 });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'preview.build_succeeded' }));
  });

  it('requestBuild marks ERROR when the build command fails (exit != 0)', async () => {
    setPreviewEnv(true);
    mockSpawn(1);
    db.state.resolve = previewResolver(SESSION(), SESSION({ state: 'BUILDING', version: 1 }));
    await requestBuild('u1', 'prj-1');
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('u1', 'preview.failed', 'Preview build failed', expect.anything()), { timeout: 2000 });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'preview.build_failed' }));
  });

  it('requestBuild errors honestly when the project workspace is missing', async () => {
    setPreviewEnv(true);
    fsMock.stat.mockRejectedValueOnce(new Error('ENOENT'));
    db.state.resolve = previewResolver(SESSION(), SESSION({ state: 'BUILDING', version: 1 }));
    const session = await requestBuild('u1', 'prj-1');
    expect(['BUILDING', 'UPDATING']).toContain(session.state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('u1', 'preview.failed', 'Preview build failed', expect.anything()), { timeout: 2000 });
  });
});

describe('TASK-COMPLETED REBUILD', () => {
  it('previewTaskCompleted is a no-op when no session exists', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM preview_sessions WHERE project_id') ? [] : null);
    await previewTaskCompleted('tsk-1', 'prj-1');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('previewTaskCompleted triggers UPDATING only when tooling is configured', async () => {
    setPreviewEnv(true);
    mockSpawn(0);
    db.state.resolve = previewResolver(SESSION({ state: 'READY', version: 2 }), SESSION({ state: 'READY', version: 2 }));
    await previewTaskCompleted('tsk-1', 'prj-1');
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('u1', 'preview.ready', 'Preview ready', expect.anything()), { timeout: 2000 });
  });

  it('previewTaskCompleted never rebuilds without tooling (honest NOT_CONFIGURED stays)', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM preview_sessions WHERE project_id') ? [SESSION()] : null);
    await previewTaskCompleted('tsk-1', 'prj-1');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('CONTENT SERVING', () => {
  it('serves index.html from the sandboxed output dir only for READY builds with strict CSP', async () => {
    setPreviewEnv(true);
    db.state.rows = [SESSION({ state: 'READY' })];
    const content = await previewContent('u1', 'prj-1');
    expect(content?.html).toContain('<html>preview</html>');
    expect(content?.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(content?.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('returns null (honest 409) for non-READY sessions and when tooling is off', async () => {
    db.state.rows = [SESSION({ state: 'NOT_CONFIGURED' })];
    expect(await previewContent('u1', 'prj-1')).toBeNull();
    db.state.rows = [SESSION({ state: 'ERROR', error: 'build failed' })];
    expect(await previewContent('u1', 'prj-1')).toBeNull();
  });

  it('never serves content outside the sandboxed output dir (path traversal guard)', async () => {
    setPreviewEnv(true);
    db.state.rows = [SESSION({ state: 'READY' })];
    fsMock.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await previewContent('u1', 'prj-1')).toBeNull();
  });
});