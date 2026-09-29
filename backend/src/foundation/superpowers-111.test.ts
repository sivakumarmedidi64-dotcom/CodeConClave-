/**
 * CodeConClave — Stage 111 SUPERPOWERS Tranche AG: Ambient Coding, Intent
 * Marketplace, Post-Human Handoff, Self-Play Adversarial Training.
 *
 *   AMBIENT CODING (#153)         — paste error anywhere, get answer.
 *   INTENT MARKETPLACE (#154)     — publish intents, agents bid, you pick.
 *   POST-HUMAN HANDOFF (#156)     — agent continues when human sleeps.
 *   SELF-PLAY ADVERSARIAL (#157)  — agents attack/defend, find novel failures.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    ambient_sessions: [] as Array<Record<string, unknown>>,
    intent_bids: [] as Array<Record<string, unknown>>,
    post_human_handoffs: [] as Array<Record<string, unknown>>,
    self_play_runs: [] as Array<Record<string, unknown>>,
  };
  const now = () => {
    tick += 1;
    return new Date(tick).toISOString();
  };
  return { tables, now };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { /* keep */ }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(text);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const row: Record<string, unknown> = { created_at: store.now(), updated_at: store.now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1]!) - 1];
          row[col] = parseVal(col, val);
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.toUpperCase().startsWith('NOW()')) {
          row[col] = store.now();
        } else if (tok.startsWith("'")) {
          row[col] = tok.slice(1, tok.endsWith("'") ? -1 : undefined);
        }
      });
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(text.toLowerCase().trim())) {
      const table = /^update (\w+)/.exec(text.toLowerCase())![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(text);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1]!) - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(text);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const col = cleanCol(pair.slice(0, eq));
          const ref = pair.slice(eq + 1).trim();
          const dollar = /^\$(\d+)$/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (/^(\w+)\s*\+\s*\$(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*\$(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(params[Number(m[2]!) - 1]);
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
          } else if (dollar) {
            const val = params[Number(dollar[1]!) - 1];
            target[col] = parseVal(col, val);
          } else if (/^now\(\)/i.test(ref)) {
            target[col] = store.now();
          } else if (ref.startsWith("'") && ref.endsWith("'")) {
            target[col] = ref.slice(1, -1);
          }
        }
      }
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    if (/select \*/.test(text.toLowerCase())) {
      const tableMatch = /from (\w+)/i.exec(text);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereTail = (/where\s+(.+)$/is.exec(text)?.[1] ?? '').replace(/\s+limit\s+\d+$/i, '');
      let filtered = [...rows];
      for (const clause of whereTail.split(/\s+and\s+/i)) {
        const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
        if (m) {
          const val = params[Number(m[2]!) - 1];
          filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
        }
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows),
    queryOne: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    AMBIENT_SESSION: 'amt',
    INTENT_BID: 'itb',
    POST_HUMAN_HANDOFF: 'phh',
    SELF_PLAY_RUN: 'ssl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createAmbientSession, answerAmbient, getAmbientSession, listAmbientSessions, ambientSessionReport } from '../modules/superpowers/ambientCoding.js';
import { createIntentBid, selectBid, getIntentBid, listIntentBids, intentMarketplaceReport } from '../modules/superpowers/intentMarketplace.js';
import { createPostHumanHandoff, continueHandoff, getPostHumanHandoff, listPostHumanHandoffs, postHumanHandoffReport } from '../modules/superpowers/postHumanHandoff.js';
import { createSelfPlayRun, reportIssue, getSelfPlayRun, listSelfPlayRuns, selfPlayReport } from '../modules/superpowers/selfPlayAdversarial.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('AMBIENT CODING (#153)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a session, answers it, and audits', async () => {
    const session = await createAmbientSession(USER, { trigger_text: 'TypeError: Cannot read property of undefined', context_path: 'src/auth/login.ts' });
    expect(session.id).toMatch(/^amt-/);
    expect(session.trigger_text).toContain('TypeError');
    expect(session.context_path).toBe('src/auth/login.ts');
    expect(session.status).toBe('PENDING');

    const answered = await answerAmbient(USER, session.id, { response: 'The error occurs because user object is null at line 42. Add a null check before accessing .email.' });
    expect(answered.status).toBe('ANSWERED');
    expect(answered.response).toContain('null check');
    expect(AUDIT_ACTIONS()).toContain('autonomy.ambient_answer_given');
  });

  it('reports ambient session totals', async () => {
    const s1 = await createAmbientSession(USER, { trigger_text: 'Segfault in renderer' });
    const s2 = await createAmbientSession(USER, { trigger_text: 'OOM in worker' });
    await answerAmbient(USER, s1.id, { response: 'Memory leak in cache' });

    const report = await ambientSessionReport(USER);
    expect(report.sessions).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.answered).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await createAmbientSession(USER, { trigger_text: 'Error: foo' });
    await expect(getAmbientSession(OTHER, s.id)).rejects.toThrow(/ambient_session_not_found/);
    await expect(listAmbientSessions(OTHER)).resolves.toHaveLength(0);
    await expect(createAmbientSession(USER, { trigger_text: '' })).rejects.toThrow(/trigger text is required/);
    await expect(answerAmbient(USER, s.id, { response: '' })).rejects.toThrow(/response is required/);
  });
});

describe('INTENT MARKETPLACE (#154)', () => {
  beforeEach(() => { cleartables(); });

  it('publishes an intent bid and selects it', async () => {
    const bid = await createIntentBid(USER, { intent_text: 'make onboarding 20% faster', agent_name: 'optimizer-v2', approach: 'Parallelize setup steps', impact_score: 8, confidence: 0.85 });
    expect(bid.id).toMatch(/^itb-/);
    expect(bid.intent_text).toBe('make onboarding 20% faster');
    expect(bid.agent_name).toBe('optimizer-v2');
    expect(bid.status).toBe('PUBLISHED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.intent_published');

    const selected = await selectBid(USER, bid.id);
    expect(selected.status).toBe('SELECTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.intent_bid_selected');
  });

  it('reports intent marketplace totals', async () => {
    await createIntentBid(USER, { intent_text: 'speed up tests', agent_name: 'a', approach: 'parallel', impact_score: 5, confidence: 0.7 });
    const b2 = await createIntentBid(USER, { intent_text: 'reduce bundle', agent_name: 'b', approach: 'tree-shake', impact_score: 6, confidence: 0.9 });
    await selectBid(USER, b2.id);

    const report = await intentMarketplaceReport(USER);
    expect(report.bids).toBe(2);
    expect(report.published).toBe(1);
    expect(report.selected).toBe(1);
    expect(report.withdrawn).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const b = await createIntentBid(USER, { intent_text: 'x', agent_name: 'a', approach: 'y', impact_score: 3, confidence: 0.5 });
    await expect(getIntentBid(OTHER, b.id)).rejects.toThrow(/intent_bid_not_found/);
    await expect(listIntentBids(OTHER)).resolves.toHaveLength(0);
    await expect(createIntentBid(USER, { intent_text: '', agent_name: 'a', approach: 'y', impact_score: 3, confidence: 0.5 })).rejects.toThrow(/intent text is required/);
    await expect(createIntentBid(USER, { intent_text: 'x', agent_name: '', approach: 'y', impact_score: 3, confidence: 0.5 })).rejects.toThrow(/agent name is required/);
  });
});

describe('POST-HUMAN HANDOFF (#156)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a handoff and continues it', async () => {
    const handoff = await createPostHumanHandoff(USER, { branch_name: 'feat/auth-middleware', last_thought: 'Need to refactor the JWT validation logic' });
    expect(handoff.id).toMatch(/^phh-/);
    expect(handoff.branch_name).toBe('feat/auth-middleware');
    expect(handoff.status).toBe('PENDING');

    const continued = await continueHandoff(USER, handoff.id, { agent_continuation: 'Refactored JWT validation to use JWK endpoint, updated 3 tests' });
    expect(continued.status).toBe('CONTINUED');
    expect(continued.agent_continuation).toContain('JWK endpoint');
    expect(AUDIT_ACTIONS()).toContain('autonomy.handoff_continued');
  });

  it('reports handoff totals', async () => {
    const h1 = await createPostHumanHandoff(USER, { branch_name: 'feat/a', last_thought: 'work on A' });
    const h2 = await createPostHumanHandoff(USER, { branch_name: 'feat/b', last_thought: 'work on B' });
    await continueHandoff(USER, h1.id, { agent_continuation: 'continued A' });

    const report = await postHumanHandoffReport(USER);
    expect(report.handoffs).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.continued).toBe(1);
    expect(report.reviewed).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const h = await createPostHumanHandoff(USER, { branch_name: 'feat/x', last_thought: 'thought' });
    await expect(getPostHumanHandoff(OTHER, h.id)).rejects.toThrow(/post_human_handoff_not_found/);
    await expect(listPostHumanHandoffs(OTHER)).resolves.toHaveLength(0);
    await expect(createPostHumanHandoff(USER, { branch_name: '', last_thought: 'thought' })).rejects.toThrow(/branch name is required/);
    await expect(createPostHumanHandoff(USER, { branch_name: 'feat/x', last_thought: '' })).rejects.toThrow(/last thought is required/);
  });
});

describe('SELF-PLAY ADVERSARIAL TRAINING (#157)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a self-play run and reports an issue', async () => {
    const run = await createSelfPlayRun(USER, { attack_vector: 'SQL injection via search endpoint', defense_used: 'parameterized queries' });
    expect(run.id).toMatch(/^ssl-/);
    expect(run.attack_vector).toContain('SQL injection');
    expect(run.status).toBe('PENDING');

    const issue = await reportIssue(USER, run.id, { vulnerability_found: 'SQL injection in /api/search allows data exfiltration', severity: 'CRITICAL' });
    expect(issue.status).toBe('COMPLETED');
    expect(issue.vulnerability_found).toContain('data exfiltration');
    expect(issue.severity).toBe('CRITICAL');
    expect(AUDIT_ACTIONS()).toContain('autonomy.self_play_issue_found');
  });

  it('reports self-play run totals', async () => {
    const r1 = await createSelfPlayRun(USER, { attack_vector: 'XSS', defense_used: 'sanitization' });
    const r2 = await createSelfPlayRun(USER, { attack_vector: 'SSRF', defense_used: 'allowlist' });
    await reportIssue(USER, r1.id, { vulnerability_found: 'Reflected XSS in /profile', severity: 'HIGH' });

    const report = await selfPlayReport(USER);
    expect(report.runs).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.issues_found).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const r = await createSelfPlayRun(USER, { attack_vector: 'injection', defense_used: 'guard' });
    await expect(getSelfPlayRun(OTHER, r.id)).rejects.toThrow(/self_play_run_not_found/);
    await expect(listSelfPlayRuns(OTHER)).resolves.toHaveLength(0);
    await expect(createSelfPlayRun(USER, { attack_vector: '', defense_used: 'guard' })).rejects.toThrow(/attack vector is required/);
    await expect(createSelfPlayRun(USER, { attack_vector: 'xss', defense_used: '' })).rejects.toThrow(/defense used is required/);
  });
});
