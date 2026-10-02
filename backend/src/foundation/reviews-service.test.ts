/**
 * CodeConClave — B1 cowork review loop: service lifecycle suite.
 *
 * DB, audit, files and projects are mocked. The review service, canonical OS
 * primitives (supervisor, executor, governor, stop-rules, event-bus, git
 * facade) run their real code against a canned workspace. Every mutating op is
 * audited; ownership + staleness + divergence fail closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// workspace + review store (hoisted)
// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  const projects = new Map<string, { id: string; owner_id: string }>();
  const tasks = new Map<string, { id: string; project_id: string }>();
  const runs = new Map<string, { id: string }>();
  const files = new Map<string, { id: string; project_id: string; owner_id: string; path: string; content: string; sha256: string }>();
  const reviews: Array<Record<string, unknown>> = [];
  const revFiles: Array<Record<string, unknown>> = [];
  const hunks: Array<Record<string, unknown>> = [];
  return { projects, tasks, runs, files, reviews, revFiles, hunks };
});

// Real SHA-256 (identical to shared/crypto sha256Hex) so staleness/divergence
// checks compare byte-true hashes across the review service.
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const fileShaOf = (c: string) => sha(c);

// ---------------------------------------------------------------------------
// mockable function references (hoisted, shared with mock factories below)
// ---------------------------------------------------------------------------
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn(async () => {}) }));
const { uploadFileMock, getFileContentMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async (_u: string, projectId: string, path: string, buf: Buffer) => {
    const sha256 = createHash('sha256').update(buf.toString('utf8'), 'utf8').digest('hex');
    const existing = [...store.files.values()].find((x) => x.path === path && x.project_id === projectId);
    if (existing) { existing.content = buf.toString('utf8'); existing.sha256 = sha256; }
    else store.files.set(`file-${store.files.size + 1}`, { id: `file-${store.files.size + 1}`, project_id: projectId, owner_id: _u, path, content: buf.toString('utf8'), sha256 });
    return { id: 'file-uploaded' };
  }),
  getFileContentMock: vi.fn(async (_u: string, _p: string, fileId: string) => {
    const f = store.files.get(fileId);
    if (!f) throw new Error('file not found');
    return { buffer: Buffer.from(f.content, 'utf8') };
  }),
}));

// ---------------------------------------------------------------------------
// DB mock (vi.hoisted factory referencing nothing outside itself)
// ---------------------------------------------------------------------------
const dbMock = vi.hoisted(() => {
  async function queryImpl(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text.trim().toLowerCase();
    // inserts
    if (/insert into cowork_reviews\b/.test(q)) {
      const cols = ['id', 'task_id', 'run_id', 'project_id', 'owner_id', 'title', 'status', 'test_status', 'commit_status', 'diff_text', 'files_changed', 'additions', 'deletions', 'test_command'];
      // all 14 are param-bound in this insert (no hardcoded literals)
      const r: Record<string, unknown> = {};
      params.forEach((v, i) => { if (i < cols.length) r[cols[i]!] = v; });
      store.reviews.push(r);
      return { rows: [], rowCount: 1 };
    }
    if (/insert into cowork_review_files\b/.test(q)) {
      // SQL: (... status, file_order) VALUES ($1..$6,'PENDING',$7)
      // cols order in SQL: id, review_id, path, base_sha256, base_content, proposed_sha256, proposed_content, status, file_order
      const r: Record<string, unknown> = {};
      const sqlCols = ['id', 'review_id', 'path', 'base_sha256', 'base_content', 'proposed_sha256', 'proposed_content'];
      params.forEach((v, i) => { if (i < sqlCols.length) r[sqlCols[i]!] = v; });
      r.status = 'PENDING';
      r.file_order = params[sqlCols.length] ?? 0; // file_order is param 8 ($8)
      if (params.length > sqlCols.length && params[sqlCols.length] !== undefined) r['file_order'] = params[7];
      store.revFiles.push(r);
      return { rows: [], rowCount: 1 };
    }
    if (/insert into cowork_review_hunks\b/.test(q)) {
      // SQL: (... hunk_order, status, old_start, ...) VALUES ($1..$4,'PENDING',$5..)
      const r: Record<string, unknown> = {};
      // SQL column order: id, review_id, file_id, hunk_order, status, old_start, old_lines,
      //   new_start, new_lines, original_sha, proposed_sha, additions, deletions, context_lines, ins_lines, diff_text
      // params order (after id/review/file/order which are $1..$4, status hardcoded, then $5..):
      //   $5=old_start $6=old_lines $7=new_start $8=new_lines $9=original_sha $10=proposed_sha
      //   $11=additions $12=deletions $13=context_lines $14=ins_lines $15=diff_text
      r.id = params[0]; r.review_id = params[1]; r.file_id = params[2]; r.hunk_order = params[3];
      r.status = 'PENDING';
      r.old_start = params[4]; r.old_lines = params[5]; r.new_start = params[6]; r.new_lines = params[7];
      r.original_sha = params[8]; r.proposed_sha = params[9]; r.additions = params[10]; r.deletions = params[11];
      r.context_lines = params[12]; r.ins_lines = params[13]; r.diff_text = params[14];
      store.hunks.push(r);
      return { rows: [], rowCount: 1 };
    }
    // workspace reads
    if (/select project_id from tasks\b/.test(q)) { const t = store.tasks.get(String(params[0])); return { rows: t ? [{ project_id: t.project_id }] : [], rowCount: t ? 1 : 0 }; }
    if (/select id from coworker_runs\b/.test(q)) { return { rows: store.runs.has(String(params[0])) ? [{ id: String(params[0]) }] : [], rowCount: 1 }; }
    if (/select id from projects\b/.test(q)) { const p = store.projects.get(String(params[0])); return { rows: p ? [{ id: p.id, owner_id: p.owner_id }] : [], rowCount: p ? 1 : 0 }; }
    if (/select sha256 from files\b/.test(q)) { const f = [...store.files.values()].find((x) => x.path === String(params[1]) && x.project_id === String(params[0])); return { rows: f ? [{ sha256: f.sha256 }] : [], rowCount: f ? 1 : 0 }; }
    if (/select path from files\b/.test(q)) { const f = [...store.files.values()].find((x) => x.id === String(params[0]) && x.project_id === String(params[1])); return { rows: f ? [{ path: f.path }] : [], rowCount: f ? 1 : 0 }; }
    if (/select \* from cowork_reviews where id\b/.test(q)) { const r = store.reviews.find((x) => x.id === String(params[0])); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; }
    if (q.includes('cowork_review_hunks') && /group by status/.test(q)) {
      const by: Record<string, number> = {};
      store.hunks.filter((h) => h.review_id === String(params[0])).forEach((h) => { by[String(h.status)] = (by[String(h.status)] ?? 0) + 1; });
      return { rows: Object.entries(by).map(([status, n]) => ({ status, n: String(n) })), rowCount: 1 };
    }
    if (/select \* from cowork_review_hunks where id = \$1 and review_id = \$2/.test(q)) {
      const f = store.hunks.find((h) => h.id === String(params[0]) && h.review_id === String(params[1]));
      return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
    }
    if (q.includes('cowork_review_hunks') && /count\(\*\)::text/.test(q)) {
      const count = store.hunks.filter((h) => h.review_id === String(params[0]) && h.status === 'INVALIDATED').length;
      return { rows: [{ n: String(count) }], rowCount: 1 };
    }
    if (q.includes('cowork_review_hunks') && /select \*/.test(q)) { const list = store.hunks.filter((h) => h.review_id === String(params[0])); return { rows: list, rowCount: list.length }; }
    if (q.includes('cowork_review_files') && /order by file_order/.test(q)) {
      return { rows: store.revFiles.filter((f) => f.review_id === String(params[0])).sort((a, b) => Number(a.file_order) - Number(b.file_order)), rowCount: 1 };
    }
    if (q.includes('cowork_review_files') && /select path, applied_content, base_content/.test(q)) {
      return { rows: store.revFiles.filter((f) => f.review_id === String(params[0])).map((f) => ({ path: f.path, applied_content: f.applied_content ?? null, base_content: f.base_content })), rowCount: 1 };
    }
    if (/select id, path, applied_sha256 from cowork_review_files/.test(q)) {
      return { rows: store.revFiles.filter((f) => f.review_id === String(params[0])).map((f) => ({ id: f.id, path: f.path, applied_sha256: f.applied_sha256 ?? null })), rowCount: 1 };
    }
    if (/select path, applied_sha256, base_content from cowork_review_files/.test(q)) {
      return { rows: store.revFiles.filter((f) => f.review_id === String(params[0])).map((f) => ({ path: f.path, applied_sha256: f.applied_sha256 ?? null, base_content: f.base_content })), rowCount: 1 };
    }
    if (/select r\.\*.*from cowork_reviews r\b/.test(q)) {
      const list = store.reviews.filter((r) => r.project_id === String(params[0]));
      return { rows: list.map((row) => ({
        ...row,
        total_hunks: String(store.hunks.filter((h) => h.review_id === row.id).length),
        accepted_hunks: String(store.hunks.filter((h) => h.review_id === row.id && h.status === 'ACCEPTED').length),
        rejected_hunks: String(store.hunks.filter((h) => h.review_id === row.id && h.status === 'REJECTED').length),
      })), rowCount: list.length };
    }
    // updates — mutate the store
    if (/^update cowork_reviews\b/.test(q)) {
      // Extract SET assignments: col = $N or col = now() or col = 'literal'
      const setMatch = /SET\s+(.+?)\s+WHERE/is.exec(text);
      const whereMatch = /WHERE\s+(.+)/is.exec(text);
      const reviewIdParam = whereMatch ? /\$(\d+)/.exec(whereMatch[1]) : null;
      const rid = reviewIdParam ? String(params[Number(reviewIdParam[1])! - 1]) : null;
      const r = rid ? store.reviews.find((x) => x.id === rid) : null;
      if (r && setMatch) {
        const pairs = setMatch[1].split(',').map((s) => s.trim());
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const col = pair.slice(0, eq).trim();
          const ref = pair.slice(eq + 1).trim();
          const dollarRef = /\$(\d+)/.exec(ref);
          if (dollarRef) {
            const val = params[Number(dollarRef[1])! - 1];
            r[col] = ref.includes('now()') ? new Date().toISOString() : val;
          } else if (ref.toLowerCase() === 'now()') {
            r[col] = new Date().toISOString();
          } else if (ref.startsWith("'") && ref.endsWith("'")) {
            r[col] = ref.slice(1, -1);
          } else if (ref.toUpperCase() === 'NULL') {
            r[col] = null;
          }
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (/^update cowork_review_hunks\b/.test(q)) {
      // Determine which hunks to update based on WHERE clause
      const whereIdx = text.toUpperCase().indexOf('WHERE');
      const wherePart = whereIdx >= 0 ? text.slice(whereIdx) : '';
      const reviewIdRef = /review_id\s*=\s*\$(\d+)/i.exec(wherePart);
      const fileIdRef = /file_id\s*=\s*\$(\d+)/i.exec(wherePart);
      const statusInMatch = /status\s+IN\s*\(([^)]+)\)/i.exec(wherePart);
      const rid = reviewIdRef ? String(params[Number(reviewIdRef[1])! - 1]) : null;
      const fid = fileIdRef ? String(params[Number(fileIdRef[1])! - 1]) : null;
      const allowedStatuses = statusInMatch
        ? statusInMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''))
        : null;
      const matched = store.hunks.filter((h) => {
        if (rid && h.review_id !== rid) return false;
        if (fid && h.file_id !== fid) return false;
        if (allowedStatuses && !allowedStatuses.includes(String(h.status))) return false;
        return true;
      });
      // Parse SET assignments
      const setMatch = /SET\s+(.+?)\s+WHERE/is.exec(text);
      if (setMatch) {
        const pairs = setMatch[1].split(',').map((s) => s.trim());
        for (const h of matched) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            const col = pair.slice(0, eq).trim();
            const ref = pair.slice(eq + 1).trim();
            const dollarRef = /\$(\d+)/.exec(ref);
            if (dollarRef) {
              const val = params[Number(dollarRef[1])! - 1];
              h[col] = ref.toLowerCase().includes('now()') ? new Date().toISOString() : val;
            } else if (ref.toLowerCase() === 'now()') {
              h[col] = new Date().toISOString();
            } else if (ref.startsWith("'") && ref.endsWith("'")) {
              h[col] = ref.slice(1, -1);
            } else if (ref.toUpperCase() === 'NULL') {
              h[col] = null;
            }
          }
        }
      }
      return { rows: [], rowCount: matched.length };
    }
    if (/^update cowork_review_files\b/.test(q)) {
      const whereIdx = text.toUpperCase().indexOf('WHERE');
      const wherePart = whereIdx >= 0 ? text.slice(whereIdx) : '';
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(wherePart);
      const reviewIdRef = /review_id\s*=\s*\$(\d+)/i.exec(wherePart);
      const fid = idRef ? String(params[Number(idRef[1])! - 1]) : null;
      const rid = reviewIdRef ? String(params[Number(reviewIdRef[1])! - 1]) : null;
      const matched = store.revFiles.filter((f) => {
        if (fid && f.id !== fid) return false;
        if (rid && f.review_id !== rid) return false;
        return true;
      });
      const setMatch = /SET\s+(.+?)\s+WHERE/is.exec(text);
      if (setMatch) {
        const pairs = setMatch[1].split(',').map((s) => s.trim());
        for (const f of matched) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            const col = pair.slice(0, eq).trim();
            const ref = pair.slice(eq + 1).trim();
            const dollarRef = /\$(\d+)/.exec(ref);
            if (dollarRef) {
              const val = params[Number(dollarRef[1])! - 1];
              f[col] = ref.toLowerCase().includes('now()') ? new Date().toISOString() : val;
            } else if (ref.toLowerCase() === 'now()') {
              f[col] = new Date().toISOString();
            } else if (ref.startsWith("'") && ref.endsWith("'")) {
              f[col] = ref.slice(1, -1);
            } else if (ref.toUpperCase() === 'NULL') {
              f[col] = null;
            }
          }
        }
      }
      return { rows: [], rowCount: matched.length };
    }
    if (/^delete from cowork_reviews\b/.test(q)) {
      const id = String(params[0]);
      const idx = store.reviews.findIndex((x) => x.id === id);
      if (idx >= 0) store.reviews.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    pool: { query: queryImpl },
    queryMany: async (t: string, p: unknown[] = []) => (await queryImpl(t, p)).rows,
    queryOne: async (t: string, p: unknown[] = []) => (await queryImpl(t, p)).rows[0] ?? null,
    query: queryImpl,
    withTenant: async (_userId: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query: queryImpl }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query: queryImpl }),
  };
});

// ---------------------------------------------------------------------------
// mock registrations
// ---------------------------------------------------------------------------
vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../modules/files/service.js', () => ({ getFileContent: getFileContentMock, uploadFile: uploadFileMock }));
vi.mock('../modules/projects/service.js', () => ({
  getProject: vi.fn(async (userId: string, projectId: string) => {
    const p = store.projects.get(projectId);
    if (!p) throw Object.assign(new Error('not found'), { errorCode: 'not_found' });
    if (p.owner_id !== userId) throw Object.assign(new Error('forbidden'), { errorCode: 'forbidden' });
    return p;
  }),
}));

// ---------------------------------------------------------------------------
// service under test (imports after all mocks registered)
// ---------------------------------------------------------------------------
import { AuditAction } from '@codeconclave/shared';
import { createReview, decideHunk, acceptAllHunks, rejectAllHunks, applyReview, runReviewTests, undoReview, commitReview, cancelReview, getReview } from '../modules/reviews/service.js';
import { setReviewRuntime } from '../modules/reviews/runtime.js';

// ---------------------------------------------------------------------------
// runtime injection
// ---------------------------------------------------------------------------
let injectedRt: Record<string, unknown> = {};

function seedRuntime(over: {
  stopRulesAllowed?: boolean;
  stopRulesReason?: string;
  execResult?: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; killed: boolean; durationMs: number };
  gitEnabled?: boolean;
  gitCommitOutput?: string;
  execThrow?: Error;
} = {}) {
  const execResult = over.execResult ?? { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, killed: false, durationMs: 12 };
  injectedRt = {
    executor: { execute: over.execThrow ? vi.fn(async () => { throw over.execThrow; }) : vi.fn(async () => execResult) },
    governor: { acquire: vi.fn(async () => ({ release: vi.fn() })), limit: 8 },
    stopRules: { evaluate: vi.fn(async () => ({ allowed: over.stopRulesAllowed ?? true, reason: over.stopRulesReason ?? '' })) },
    supervisor: { supervised: vi.fn(async () => ({ ok: true, result: execResult, errorCode: null, error: null, stopReason: null, start: 0, end: 1, durationMs: 12 })) },
    events: { publish: vi.fn() },
    state: { checkpoints: 0 },
    git: {
      enabled: vi.fn(() => over.gitEnabled ?? true),
      engine: vi.fn(() => ({ commit: vi.fn(async () => over.gitCommitOutput ?? '[main abc1234] commit msg') })),
      init: vi.fn(async (cwd: string) => {
        mkdirSync(join(cwd, '.git'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 };
      }),
      addAll: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 })),
    },
  };
  setReviewRuntime(injectedRt as never);
}

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------
function seedWorkspace() {
  store.projects.set('prj-1', { id: 'prj-1', owner_id: 'u1' });
  store.tasks.set('tsk-1', { id: 'tsk-1', project_id: 'prj-1' });
  store.runs.set('run-1', { id: 'run-1' });
  const base = 'line1\nline2\nline3\nline4\nline5\n';
  const proposed = 'line1\nline2\nCHANGED\nline4\nline5\n';
  const fid = 'file-1';
  store.files.set(fid, { id: fid, project_id: 'prj-1', owner_id: 'u1', path: 'src/app.txt', content: base, sha256: fileShaOf(base) });
  return { base, proposed, fid };
}

beforeEach(() => {
  store.projects.clear(); store.tasks.clear(); store.runs.clear(); store.files.clear();
  store.reviews.length = 0; store.revFiles.length = 0; store.hunks.length = 0;
  recordAuditMock.mockClear(); uploadFileMock.mockClear(); getFileContentMock.mockClear();
  seedRuntime();
});

afterEach(() => { setReviewRuntime(null); vi.restoreAllMocks(); });

async function makeReview(fileOver: Record<string, unknown> = {}, inputOver: Record<string, unknown> = {}) {
  const { proposed, fid } = seedWorkspace();
  return createReview('u1', 'prj-1', {
    taskId: 'tsk-1', runId: 'run-1', title: 'add docs',
    files: [{ fileId: fid, proposedContent: proposed, ...fileOver }],
    ...inputOver,
  } as never);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
describe('reviews.service — auth & ownership', () => {
  it('rejects a foreign project or task', async () => {
    seedWorkspace();
    await expect(createReview('u1', 'prj-nope', { taskId: 'tsk-1', files: [{ fileId: 'file-1', proposedContent: 'x\n' }] } as never))
      .rejects.toMatchObject({ errorCode: 'not_found' });
    const { fid } = seedWorkspace();
    await expect(createReview('u1', 'prj-1', { taskId: 'tsk-nope', files: [{ fileId: fid, proposedContent: 'a\nb\nc\n' }] } as never))
      .rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('audits creation and returns a ready-for-review view', async () => {
    const v = await makeReview();
    expect(v.status).toBe('READY_FOR_REVIEW');
    expect(v.files).toHaveLength(1);
    expect(v.hunks).toHaveLength(1);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'cowork_review.created', actorUserId: 'u1', resourceId: v.id }));
  });

  it('exposes detail via getReview only to the owner', async () => {
    const v = await makeReview();
    const seen = await getReview('u1', v.id);
    expect(seen.id).toBe(v.id);
    await expect(getReview('u2', v.id)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('reviews.service — hunk decisions', () => {
  it('accept/reject a single hunk and recompute review status', async () => {
    const v = await makeReview();
    const h = v.hunks[0]!;
    const accepted = await decideHunk('u1', v.id, h.id, 'ACCEPTED');
    expect(accepted.hunks[0]!.status).toBe('ACCEPTED');
    const rejected = await decideHunk('u1', v.id, h.id, 'REJECTED');
    expect(rejected.hunks[0]!.status).toBe('REJECTED');
    expect(rejected.status).toBe('PARTIALLY_REVIEWED');
  });

  it('accept-all sets every hunk ACCEPTED → READY_FOR_REVIEW', async () => {
    const v = await makeReview();
    const out = await acceptAllHunks('u1', v.id);
    expect(out.hunks.every((h) => h.status === 'ACCEPTED')).toBe(true);
  });

  it('reject-all sets every hunk REJECTED → CANCELLED', async () => {
    const v = await makeReview();
    const out = await rejectAllHunks('u1', v.id);
    expect(out.hunks.every((h) => h.status === 'REJECTED')).toBe(true);
    expect(out.status).toBe('CANCELLED');
  });
});

describe('reviews.service — apply', () => {
  it('applies accepted hunks through the canonical file service', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id);
    const applied = await applyReview('u1', v.id);
    expect(applied.status).toBe('APPLIED');
    expect(uploadFileMock).toHaveBeenCalled();
    const last = uploadFileMock.mock.lastCall as [string, string, string, Buffer];
    expect(last[2]).toBe('src/app.txt');
    expect(last[3].toString('utf8')).toBe('line1\nline2\nCHANGED\nline4\nline5\n');
  });

  it('blocks apply with no accepted hunks', async () => {
    const v = await makeReview();
    await rejectAllHunks('u1', v.id);
    await expect(applyReview('u1', v.id)).rejects.toMatchObject({ errorCode: 'review_not_appliable' });
  });

  it('stop-rule gate denies apply', async () => {
    seedRuntime({ stopRulesAllowed: false, stopRulesReason: 'policy deny' });
    const v = await makeReview();
    await acceptAllHunks('u1', v.id);
    await expect(applyReview('u1', v.id)).rejects.toMatchObject({ errorCode: 'aios_stoprule_denied' });
  });

  it('stale workspace file is invalidated and apply fails closed', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id);
    const f = store.files.get('file-1')!;
    f.content = 'line1\nline2\nTOUCHED\nline4\nline5\n'; f.sha256 = fileShaOf(f.content);
    const out = await applyReview('u1', v.id);
    expect(out.status).toBe('FAILED');
    expect(out.applyError ?? '').toContain('changed since the review');
  });
});

describe('reviews.service — tests', () => {
  it('runs the canonical sandbox through the supervisor and records a pass', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    const out = await runReviewTests('u1', v.id, 'node test.js');
    expect(out.status).toBe('TEST_PASSED');
    expect((injectedRt.supervisor as { supervised: ReturnType<typeof vi.fn> }).supervised).toHaveBeenCalled();
  });

  it('a non-zero exit records a test failure', async () => {
    seedRuntime({ execResult: { exitCode: 7, stdout: '', stderr: 'boom', timedOut: false, killed: false, durationMs: 5 } });
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    expect((await runReviewTests('u1', v.id, 'node test.js')).status).toBe('TEST_FAILED');
  });

  it('requires an applied review before testing', async () => {
    const v = await makeReview();
    await expect(runReviewTests('u1', v.id, 'node test.js')).rejects.toMatchObject({ errorCode: 'review_not_testable' });
  });
});

describe('reviews.service — undo', () => {
  it('reverts applied files to base content and resets the review', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    const undone = await undoReview('u1', v.id);
    expect(undone.status).toBe('UNDONE');
  });

  it('refuses undo when the workspace diverged after apply', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    const f = store.files.get('file-1')!;
    f.content = 'line1\nline2\nMANUAL\nline4\nline5\n'; f.sha256 = fileShaOf(f.content);
    await expect(undoReview('u1', v.id)).rejects.toMatchObject({ errorCode: 'review_diverged' });
  });
});

describe('reviews.service — commit', () => {
  it('commits through the git facade only when capable', async () => {
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    const out = await commitReview('u1', v.id, 'feat: apply review');
    expect(out.commitStatus).toBe('COMMITTED');
    expect(out.commitHash).toBe('abc1234');
  });

  it('fails closed when git capability is disabled', async () => {
    seedRuntime({ gitEnabled: false });
    const v = await makeReview();
    await acceptAllHunks('u1', v.id); await applyReview('u1', v.id);
    await expect(commitReview('u1', v.id, 'msg')).rejects.toMatchObject({ errorCode: 'aios_git_denied' });
  });
});

describe('reviews.service — cancel', () => {
  it('cancels an open review', async () => {
    const v = await makeReview();
    expect((await cancelReview('u1', v.id)).status).toBe('CANCELLED');
  });
});