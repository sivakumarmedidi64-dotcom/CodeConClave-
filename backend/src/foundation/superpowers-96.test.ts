/**
 * CodeConClave — Stage 96 SUPERPOWERS Tranche R: Focus Forge, Clone Killer,
 * Error Translator, Pair Mirror, Meeting-to-Code.
 *
 *   FOCUS FORGE (#62)           — deep work detected, non-P0 chatter silenced,
 *                                 P0s break through, digest on surface.
 *   CLONE KILLER (#63)          — semantic dedup: same skeleton, foreign names.
 *   ERROR TRANSLATOR (#64)      — cryptic errors into one sentence + exact fix.
 *   PAIR MIRROR (#65)           — the pattern your team prefers, before you
 *                                 finish the line.
 *   MEETING-TO-CODE (#66)       — paste a transcript, get tasks + PR plan.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    focus_sessions: [] as Array<Record<string, unknown>>,
    clone_fragments: [] as Array<Record<string, unknown>>,
    error_translations: [] as Array<Record<string, unknown>>,
    pair_hints: [] as Array<Record<string, unknown>>,
    meeting_extractions: [] as Array<Record<string, unknown>>,
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
    FOCUS_SESSION: 'fcs',
    CLONE_FRAGMENT: 'cln',
    ERROR_TRANSLATION: 'ert',
    PAIR_HINT: 'phn',
    MEETING_EXTRACTION: 'm2c',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { forgeFocusSession, silenceFocus, breachFocus, digestFocus, getFocusSession, listFocusSessions, focusReport } from '../modules/superpowers/focusForge.js';
import { registerFragment, proposeAbstraction, signatureFor, getCloneFragment, listCloneFragments, cloneKillerReport } from '../modules/superpowers/cloneKiller.js';
import { translateErrorText, translateError, getErrorTranslation, listErrorTranslations, errorTranslatorReport } from '../modules/superpowers/errorTranslator.js';
import { mirrorHint, acknowledgeHint, detectPattern, getPairHint, listPairHints, pairMirrorReport } from '../modules/superpowers/pairMirror.js';
import { extractMeeting, getMeetingExtraction, listMeetingExtractions, meetingToCodeReport } from '../modules/superpowers/meetingToCode.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('FOCUS FORGE (#62)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('detects a sustained-edit deep work session', async () => {
    const s = await forgeFocusSession(USER, { activity: 'rework the checkout seams', intensity: 8 });
    expect(s.id).toMatch(/^fcs-/);
    expect(s.status).toBe('DETECTED');
    expect(s.held).toBe(0);
    expect(s.breached).toBe(0);
    expect(s.digest).toEqual([]);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_session_opened');
  });

  it('silences non-P0 chatter, lets P0 through, and delivers the digest on surface', async () => {
    const s = await forgeFocusSession(USER, { activity: 'checkout rework', intensity: 7 });
    const silenced = await silenceFocus(USER, s.id, { held: ['who changed the billing flag?', 'username case question'] });
    expect(silenced.status).toBe('SILENCED');
    expect(silenced.held).toBe(2);
    expect(silenced.digest).toHaveLength(2);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_session_silenced');

    const breached = await breachFocus(USER, s.id, { p0: 'production checkout is down' });
    expect(breached.breached).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_session_breached');

    const done = await digestFocus(USER, s.id);
    expect(done.status).toBe('DONE');
    expect(done.digest).toHaveLength(2);
    expect(done.breached).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.focus_session_digested');

    await expect(silenceFocus(USER, s.id, { held: ['late'] })).rejects.toThrow(/already silent or over/);
    await expect(breachFocus(USER, s.id, { p0: 'late p0' })).rejects.toThrow(/focus session is over/);
    await expect(digestFocus(USER, s.id)).rejects.toThrow(/already delivered/);
  });

  it('reports sessions and stays owner-scoped', async () => {
    const a = await forgeFocusSession(USER, { activity: 'plumbing audit', intensity: 4 });
    await forgeFocusSession(USER, { activity: 'schema renames', intensity: 6 });
    const report = await focusReport(USER);
    expect(report.sessions).toBe(2);
    expect(report.active).toBe(2);
    expect(report.silenced).toBe(0);
    expect(report.done).toBe(0);
    expect(report.avg_intensity).toBe(5);
    await expect(getFocusSession(OTHER, a.id)).rejects.toThrow(/focus_session_not_found/);
    await expect(listFocusSessions(OTHER)).resolves.toHaveLength(0);
  });

  it('validates', async () => {
    await expect(forgeFocusSession(USER, { activity: '', intensity: 5 })).rejects.toThrow(/what you are working on/);
    await expect(forgeFocusSession(USER, { activity: 'a', intensity: 99 })).rejects.toThrow(/between 1 and 10/);
    const s = await forgeFocusSession(USER, { activity: 'a', intensity: 5 });
    await expect(digestFocus(USER, s.id)).rejects.toThrow(/silence the world first/);
  });
});

describe('CLONE KILLER (#63)', () => {
  const CODE_A = 'for (var i = 0; i < items; i++) { var total = 0; total = total + items[i]; return total; }';
  const CODE_B = 'let sum = 0; for (const item of items) { sum = sum + item; } return sum;';
  const CODE_C = 'while (true) { if (retry) { try { retry(); } catch (e) { break; } } }';

  beforeEach(() => {
    cleartables();
  });

  it('sees the same skeleton under different names', () => {
    expect(signatureFor(CODE_A)).toBe(signatureFor(CODE_B));
    expect(signatureFor(CODE_B)).not.toBe(signatureFor(CODE_C));
  });

  it('registers fragments and proposes the canonical abstraction', async () => {
    const a = await registerFragment(USER, { name: 'checkout total', language: 'javascript', code: CODE_A });
    const b = await registerFragment(USER, { name: 'invoice total', language: 'javascript', code: CODE_B });
    expect(a.id).toMatch(/^cln-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.clone_registered');

    const abstracted = await proposeAbstraction(USER, a.id);
    expect(abstracted.abstraction).toContain('2-wise javascript clone');
    expect(abstracted.abstraction).toContain('checkout total + invoice total');
    expect(abstracted.abstraction).toContain('one canonical abstraction');
    expect(AUDIT_ACTIONS()).toContain('autonomy.clone_matched');
    expect(AUDIT_ACTIONS()).toContain('autonomy.clone_abstraction_proposed');
    expect(b.abstraction).toBeNull();
  });

  it('reports clones found and stays owner-scoped', async () => {
    await registerFragment(USER, { name: 'checkout total', language: 'javascript', code: CODE_A });
    await registerFragment(USER, { name: 'invoice total', language: 'javascript', code: CODE_B });
    const unique = await registerFragment(USER, { name: 'retry loop', language: 'javascript', code: CODE_C });

    await expect(proposeAbstraction(USER, unique.id)).rejects.toThrow(/clone_twin_not_found/);

    const report = await cloneKillerReport(USER);
    expect(report.fragments).toBe(3);
    expect(report.languages).toBe(1);
    expect(report.matched).toBe(2);
    expect(report.abstractions_proposed).toBe(0);

    await expect(getCloneFragment(OTHER, unique.id)).rejects.toThrow(/clone_fragment_not_found/);
    await expect(listCloneFragments(OTHER)).resolves.toHaveLength(0);
  });

  it('validates', async () => {
    await expect(registerFragment(USER, { name: '', language: 'javascript', code: CODE_A })).rejects.toThrow(/a name is required/);
    await expect(registerFragment(USER, { name: 'x', language: '', code: CODE_A })).rejects.toThrow(/a language is required/);
    await expect(registerFragment(USER, { name: 'x', language: 'js', code: '   ' })).rejects.toThrow(/the code region is required/);
  });
});

describe('ERROR TRANSLATOR (#64)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('rewrites a stack trace into one sentence and a fix', async () => {
    const t = await translateErrorText(USER, {
      raw: "TypeError: Cannot read properties of undefined (reading 'width')\n    at renderCard (/src/ui/card.js:42:11)",
    });
    expect(t.id).toMatch(/^ert-/);
    expect(t.kind).toBe('runtime_undefined');
    expect(t.line).toBe('/src/ui/card.js:42');
    expect(t.sentence).toContain('never defined');
    expect(t.fix).toContain('guard');
    expect(AUDIT_ACTIONS()).toContain('autonomy.error_translated');
  });

  it('recognizes panic, SQL, and opaque stderr', async () => {
    const p = await translateErrorText(USER, { raw: 'panic: index out of bounds' });
    expect(p.kind).toBe('panic');
    expect(p.sentence).toContain('assumption');

    const sql = await translateErrorText(USER, { raw: 'ERROR: syntax error at or near "ORDER"' });
    expect(sql.kind).toBe('sql_syntax');
    expect(sql.sentence).toContain('database rejected');

    const opaque = await translateErrorText(USER, { raw: 'wobbly geometry thread died quietly' });
    expect(opaque.kind).toBe('opaque_stderr');
    expect(opaque.fix).toContain('surrounding log lines');
  });

  it('validates, reports, and stays owner-scoped', async () => {
    await expect(translateErrorText(USER, { raw: '' })).rejects.toThrow(/paste the raw stack trace/);

    const stack = await translateErrorText(USER, {
      raw: "TypeError: Cannot read properties of undefined (reading 'width')\n    at renderCard (/src/ui/card.js:42:11)",
    });
    await translateErrorText(USER, { raw: 'panic: index out of bounds' });
    await translateErrorText(USER, { raw: 'ERROR: syntax error at or near "ORDER"' });
    await translateErrorText(USER, { raw: 'wobbly geometry thread died quietly' });

    const report = await errorTranslatorReport(USER);
    expect(report.translations).toBe(4);
    expect(report.kinds).toBe(4);
    expect(report.lines_identified).toBe(1);

    await expect(getErrorTranslation(OTHER, stack.id)).rejects.toThrow(/error_translation_not_found/);
    await expect(listErrorTranslations(OTHER)).resolves.toHaveLength(0);
  });
});

describe('PAIR MIRROR (#65)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('suggests the team pattern before you finish the line', async () => {
    const h = await mirrorHint(USER, { edit: 'async function handleCheckout(req, res) {' });
    expect(h.id).toMatch(/^phn-/);
    expect(h.pattern).toBe('validation_before_write');
    expect(h.suggestion).toContain('validates inputs');
    expect(detectPattern('async function handleCheckout(req, res) {').name).toBe('validation_before_write');
    expect(AUDIT_ACTIONS()).toContain('autonomy.pair_hint_given');
  });

  it('wraps HTTP calls and breathes otherwise', async () => {
    const http = await mirrorHint(USER, { edit: 'const res = await fetch(url);' });
    expect(http.pattern).toBe('wrap_http_in_error_handling');
    expect(http.suggestion).toContain('wrap it in error handling');

    const idle = await mirrorHint(USER, { edit: 'const x = 1 + 2;' });
    expect(idle.pattern).toBe('breathe');
  });

  it('acknowledges hints, reports, and stays owner-scoped', async () => {
    const main = await mirrorHint(USER, { edit: 'async function handleCheckout(req, res) {' });
    await mirrorHint(USER, { edit: 'const res = await fetch(url);' });
    await mirrorHint(USER, { edit: 'const x = 1 + 2;' });

    const acked = await acknowledgeHint(USER, main.id);
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.pair_hint_acknowledged');
    await expect(acknowledgeHint(USER, main.id)).rejects.toThrow(/already acknowledged/);

    const report = await pairMirrorReport(USER);
    expect(report.hints).toBe(3);
    expect(report.acknowledged).toBe(1);
    expect(report.patterns).toBe(3);

    await expect(getPairHint(OTHER, main.id)).rejects.toThrow(/pair_hint_not_found/);
    await expect(listPairHints(OTHER)).resolves.toHaveLength(0);
    await expect(mirrorHint(USER, { edit: '' })).rejects.toThrow(/what you are typing/);
  });
});

describe('MEETING-TO-CODE (#66)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('turns a transcript into issues, criteria, tasks, and a PR plan', async () => {
    const e = await extractMeeting(USER, {
      title: 'checkout retry',
      transcript: 'The checkout page crashes when a discount code is applied. The payment handler must be idempotent. We need to add a retry button.',
    });
    expect(e.id).toMatch(/^m2c-/);
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toContain('crashes');
    expect(e.acceptance_criteria).toHaveLength(1);
    expect(e.acceptance_criteria[0]).toContain('idempotent');
    expect(e.tasks).toHaveLength(1);
    expect(e.tasks[0]).toContain('retry button');
    expect(e.pr_plan).toContain('feat: checkout retry');
    expect(e.pr_plan).toContain('1 task(s)');
    expect(AUDIT_ACTIONS()).toContain('autonomy.meeting_extracted');
  });

  it('aggregates across extractions and stays owner-scoped', async () => {
    const first = await extractMeeting(USER, {
      title: 'checkout retry',
      transcript: 'The checkout page crashes when a discount code is applied. The payment handler must be idempotent. We need to add a retry button.',
    });
    await extractMeeting(USER, {
      title: 'retry flow',
      transcript: 'The retry button should show a spinner. We need to wire it to the queue.',
    });

    const report = await meetingToCodeReport(USER);
    expect(report.extractions).toBe(2);
    expect(report.issues).toBe(1);
    expect(report.criteria).toBe(2);
    expect(report.tasks).toBe(2);

    await expect(getMeetingExtraction(OTHER, first.id)).rejects.toThrow(/meeting_extraction_not_found/);
    await expect(listMeetingExtractions(OTHER)).resolves.toHaveLength(0);
  });

  it('validates', async () => {
    await expect(extractMeeting(USER, { title: '', transcript: 'anything' })).rejects.toThrow(/a meeting title is required/);
    await expect(extractMeeting(USER, { title: 'x', transcript: '' })).rejects.toThrow(/paste the transcript/);
  });
});