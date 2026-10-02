/**
 * CodeConClave — Stage 97 SUPERPOWERS Tranche S: Focus Guard, Voice to Task,
 * Requirement X-Ray, Scope Bouncer, User Story Forge.
 *
 *   FOCUS GUARD (#72)       — deep work detected, non-urgent questions held
 *                             until you surface, urgent stuff breaks through.
 *   VOICE TO TASK (#73)     — dictate on the phone, same queue as typed.
 *   REQUIREMENT X-RAY (#74) — the hidden sub-requirements behind "small" asks.
 *   SCOPE BOUNCER (#75)     — scope creep flagged mid-implementation with cost.
 *   USER STORY FORGE (#76)  — vague goal → story + executable tests.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    focus_guards: [] as Array<Record<string, unknown>>,
    voice_tasks: [] as Array<Record<string, unknown>>,
    requirement_xrays: [] as Array<Record<string, unknown>>,
    scope_bounces: [] as Array<Record<string, unknown>>,
    story_forges: [] as Array<Record<string, unknown>>,
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
          const dollar = /\$(\d+)/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (dollar) {
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
    FOCUS_GUARD: 'fgu',
    VOICE_TASK: 'vot',
    REQUIREMENT_XRAY: 'rxr',
    SCOPE_SESSION: 'scp',
    USER_STORY: 'fst',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { guardDeepWork, holdQuestion, surfaceGuard, getFocusGuard, listFocusGuards, focusGuardReport } from '../modules/superpowers/focusGuard.js';
import { dictateTask, startVoiceTask, cleanTranscript, getVoiceTask, listVoiceTasks, voiceTaskReport } from '../modules/superpowers/voiceToTask.js';
import { xrayRequirement, xrayImplications, getXray, listXrays, requirementXrayReport } from '../modules/superpowers/requirementXray.js';
import { openPrScope, checkScope, settleScope, getScopeSession, listScopeSessions, scopeBouncerReport } from '../modules/superpowers/scopeBouncer.js';
import { forgeStoryRun, forgeStory, getStory, listStories, userStoryForgeReport } from '../modules/superpowers/userStoryForge.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('FOCUS GUARD (#72)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('detects deep work and guards it', async () => {
    const s = await guardDeepWork(USER, { activity: 'sweep the auth flows', intensity: 9 });
    expect(s.id).toMatch(/^fgu-/);
    expect(s.status).toBe('GUARDED');
    expect(s.held).toBe(0);
    expect(s.urgent_out).toBe(0);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_guard_started');
  });

  it('holds non-urgent questions, lets urgent through, and surfaces the digest', async () => {
    const s = await guardDeepWork(USER, { activity: 'sweep the auth flows', intensity: 8 });
    const held = await holdQuestion(USER, s.id, { question: 'can we rename the status column?' });
    expect(held.broke_through).toBe(false);
    expect(held.held).toBe(1);
    expect(held.note).toContain('digest');
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_question_held');

    const urgent = await holdQuestion(USER, s.id, { question: 'login is down for everyone', urgent: true });
    expect(urgent.broke_through).toBe(true);
    expect(urgent.urgent_out).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_question_broke_through');

    const surfaced = await surfaceGuard(USER, s.id);
    expect(surfaced.status).toBe('RELEASED');
    expect(surfaced.digest).toHaveLength(1);
    expect(surfaced.held).toBe(1);
    expect(surfaced.urgent_out).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_guard_surfaced');

    await expect(holdQuestion(USER, s.id, { question: 'late' })).rejects.toThrow(/already surfaced/);
  });

  it('reports sessions and stays owner-scoped', async () => {
    const a = await guardDeepWork(USER, { activity: 'plumbing audit', intensity: 5 });
    await guardDeepWork(USER, { activity: 'schema renames', intensity: 7 });
    await holdQuestion(USER, a.id, { question: 'q1' });
    await holdQuestion(USER, a.id, { question: 'q2' });

    const report = await focusGuardReport(USER);
    expect(report.sessions).toBe(2);
    expect(report.held).toBe(2);
    expect(report.urgent_out).toBe(0);
    expect(report.released).toBe(0);

    await expect(getFocusGuard(OTHER, a.id)).rejects.toThrow(/focus_guard_not_found/);
    await expect(listFocusGuards(OTHER)).resolves.toHaveLength(0);
  });

  it('validates', async () => {
    await expect(guardDeepWork(USER, { activity: '', intensity: 5 })).rejects.toThrow(/what you are working on/);
    await expect(guardDeepWork(USER, { activity: 'a', intensity: 99 })).rejects.toThrow(/between 1 and 10/);
  });
});

describe('VOICE TO TASK (#73)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('cleans the dictate and drops it into the same queue as a typed instruction', async () => {
    expect(cleanTranscript('um we need to audit the sidekiq retries')).toBe('we need to audit the sidekiq retries');
    const t = await dictateTask(USER, { script: 'um we need to audit the sidekiq retries', source: 'voice' });
    expect(t.id).toMatch(/^vot-/);
    expect(t.title).toBe('we need to audit');
    expect(t.body).toBe('we need to audit the sidekiq retries');
    expect(t.status).toBe('QUEUED');
    expect(t.source).toBe('voice');
    expect(AUDIT_ACTIONS()).toContain('autonomy.voice_task_queued');
  });

  it('starts from the queue like any task', async () => {
    const t = await dictateTask(USER, { script: 'add a retry button to the checkout page' });
    const started = await startVoiceTask(USER, t.id);
    expect(started.status).toBe('STARTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.voice_task_started');
    await expect(startVoiceTask(USER, t.id)).rejects.toThrow(/already started/);
  });

  it('reports, validates, and stays owner-scoped', async () => {
    const t = await dictateTask(USER, { script: 'one' });
    await dictateTask(USER, { script: 'two' });
    await dictateTask(USER, { script: 'three' });
    await startVoiceTask(USER, t.id);

    const report = await voiceTaskReport(USER);
    expect(report.total).toBe(3);
    expect(report.queued).toBe(2);
    expect(report.started).toBe(1);
    expect(report.sources).toBe(1);

    await expect(getVoiceTask(OTHER, t.id)).rejects.toThrow(/voice_task_not_found/);
    await expect(listVoiceTasks(OTHER)).resolves.toHaveLength(0);
    await expect(dictateTask(USER, { script: '' })).rejects.toThrow(/nothing was recorded/);
  });
});

describe('REQUIREMENT X-RAY (#74)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('surfaces the hidden sub-requirements of a "small" delete request', async () => {
    const scan = await xrayRequirement(USER, { request: 'Add a delete button for user accounts' });
    expect(scan.id).toMatch(/^rxr-/);
    expect(scan.implications).toContain('soft delete + audit trail');
    expect(scan.implications).toContain('permissions update + role review');
    expect(scan.implications).toContain('a11y pass: keyboard, contrast, labels');
    expect(scan.implications).toContain('rollback plan');
    expect(AUDIT_ACTIONS()).toContain('autonomy.requirement_xrayed');
  });

  it('x-rays payments and does not invent delete checks', async () => {
    const scan = await xrayRequirement(USER, { request: 'allow customers to request a refund from the mobile app' });
    expect(scan.implications).toContain('double-charge guard');
    expect(scan.implications).toContain('ledger + reconciliation entry');
    expect(scan.implications).not.toContain('soft delete + audit trail');
    expect(xrayImplications('filter the orders by date range')).toContain('ordering / no-results edge cases');
  });

  it('reports, validates, and stays owner-scoped', async () => {
    const a = await xrayRequirement(USER, { request: 'Add a delete button for user accounts' });
    await xrayRequirement(USER, { request: 'allow customers to request a refund' });

    const report = await requirementXrayReport(USER);
    expect(report.scans).toBe(2);
    expect(report.implications).toBeGreaterThanOrEqual(11);
    expect(report.categories).toBeGreaterThanOrEqual(11);

    await expect(getXray(OTHER, a.id)).rejects.toThrow(/requirement_xray_not_found/);
    await expect(listXrays(OTHER)).resolves.toHaveLength(0);
    await expect(xrayRequirement(USER, { request: '' })).rejects.toThrow(/paste the stakeholder request/);
  });
});

describe('SCOPE BOUNCER (#75)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('flags scope creep with a separate-PR cost', async () => {
    const s = await openPrScope(USER, { title: 'checkout v2', planned_files: 4, planned_migrations: 0 });
    expect(s.id).toMatch(/^scp-/);
    expect(s.status).toBe('OPEN');
    expect(AUDIT_ACTIONS()).toContain('autonomy.scope_opened');

    const flagged = await checkScope(USER, s.id, { added_files: 3, added_migrations: 2, added_permissions: 1 });
    expect(flagged.flagged).toBe(1);
    expect(flagged.cost).toContain('2 migration(s)');
    expect(flagged.cost).toContain('1 permission model');
    expect(flagged.cost).toContain('separate PR?');
    expect(AUDIT_ACTIONS()).toContain('autonomy.scope_creep_flagged');
  });

  it('keeps a clean change unflagged and settles the scope', async () => {
    const s = await openPrScope(USER, { title: 'copy tweaks' });
    const clean = await checkScope(USER, s.id, { added_files: 0, added_migrations: 0 });
    expect(clean.flagged).toBe(0);
    expect(clean.cost).toBe('');

    const settled = await settleScope(USER, s.id);
    expect(settled.status).toBe('SETTLED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.scope_bounce_settled');

    await expect(checkScope(USER, s.id, { added_files: 1 })).rejects.toThrow(/already settled/);
  });

  it('reports and stays owner-scoped', async () => {
    const s = await openPrScope(USER, { title: 'checkout v2' });
    await openPrScope(USER, { title: 'copy tweaks' });
    await checkScope(USER, s.id, { added_migrations: 1 });
    await settleScope(USER, s.id);

    const report = await scopeBouncerReport(USER);
    expect(report.sessions).toBe(2);
    expect(report.flagged).toBe(1);
    expect(report.settled).toBe(1);

    await expect(getScopeSession(OTHER, s.id)).rejects.toThrow(/scope_bounce_not_found/);
    await expect(listScopeSessions(OTHER)).resolves.toHaveLength(0);
    await expect(openPrScope(USER, { title: '' })).rejects.toThrow(/a PR title is required/);
  });
});

describe('USER STORY FORGE (#76)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('forges a story with executable acceptance tests', async () => {
    const forged = forgeStory('As a shopper, I want to track my shipment so that I stop asking support');
    expect(forged.role).toBe('shopper');
    expect(forged.desire).toBe('track my shipment');
    expect(forged.story).toBe('As a shopper, I want to track my shipment so that I stop asking support');
    expect(forged.tests).toHaveLength(3);
    expect(forged.tests[0]).toContain('defined result');
    expect(forged.tests[2]).toContain('fails loudly');

    const row = await forgeStoryRun(USER, { goal: 'As a shopper, I want to track my shipment so that I stop asking support' });
    expect(row.id).toMatch(/^fst-/);
    expect(row.story).toContain('As a shopper');
    expect(row.tests).toHaveLength(3);
    expect(AUDIT_ACTIONS()).toContain('autonomy.story_forged');
  });

  it('handles a vague goal with a fallback role', async () => {
    const row = await forgeStoryRun(USER, { goal: 'make checkout faster' });
    expect(row.story).toContain('As a one of our users');
    expect(row.story).toContain('make checkout faster');
  });

  it('reports, validates, and stays owner-scoped', async () => {
    const a = await forgeStoryRun(USER, { goal: 'As a shopper, I want to track my shipment so that I stop asking support' });
    await forgeStoryRun(USER, { goal: 'make checkout faster' });

    const report = await userStoryForgeReport(USER);
    expect(report.stories).toBe(2);
    expect(report.tests).toBe(6);
    expect(report.roles).toBe(2);

    await expect(getStory(OTHER, a.id)).rejects.toThrow(/story_forge_not_found/);
    await expect(listStories(OTHER)).resolves.toHaveLength(0);
    await expect(forgeStoryRun(USER, { goal: '' })).rejects.toThrow(/a goal is required/);
  });
});