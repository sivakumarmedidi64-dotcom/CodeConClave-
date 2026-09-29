/**
 * CodeConClave — Stage 85 SUPERPOWERS Tranche G: memory, learning & history.
 *
 *   BLAMELESS ARCHIVIST (#48) — incidents archived with full story; related
 *                              postmortems retrieved automatically by token
 *                              overlap when a similar problem is worked.
 *   ONTOLOGY ENGINE (#50) — living dictionary of domain terms; divergence scans
 *                          flag aliases used in place of canonical names.
 *   VOICE-OF-CODEBASE (#52) — the codebase answers questions conversationally
 *                              backed by evidence from stored memory.
 *   COMMIT ARCHAEOLOGIST (#56) — origin records reconstruct the moment a
 *                               function was written: commit, author, context.
 *   SKILL TAXONOMY (#58) — commit/review/correction signals bear skill weight;
 *                          "who knows X best?" answered from data, not hunches.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    postmortems: [] as Array<Record<string, unknown>>,
    ontology_terms: [] as Array<Record<string, unknown>>,
    ontology_violations: [] as Array<Record<string, unknown>>,
    codebase_answers: [] as Array<Record<string, unknown>>,
    file_origin_insights: [] as Array<Record<string, unknown>>,
    skill_signals: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  const DEFAULTS: Record<string, Record<string, unknown>> = {
    postmortems: { project_id: null, incident_id: null, timeline: null, prevention: null },
    ontology_terms: { aliases: [], definition: null },
    ontology_violations: { status: 'OPEN' },
    codebase_answers: { evidence_sources: [] },
    file_origin_insights: { project_id: null, first_seen_date: null, pr_summary: null, context: null, depth: 1 },
    skill_signals: { domain: 'GENERAL', weight: 1, evidence_ref: null },
  };
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
      const defaults = DEFAULTS[table] ?? {};
      for (const [k, v] of Object.entries(defaults)) if (row[k] === undefined) row[k] = v;
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
    POSTMORTEM: 'pst',
    ONTOLOGY_TERM: 'ont',
    ONTOLOGY_VIOLATION: 'onv',
    CODEBASE_ANSWER: 'cba',
    ORIGIN_INSIGHT: 'cma',
    SKILL_SIGNAL: 'skt',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { archivePostmortem, listPostmortems, retrieveRelatedPostmortems } from '../modules/superpowers/archivist.js';
import { registerTerm, listTerms, logTermScan, listViolations, resolveViolation, unifyTerm } from '../modules/superpowers/ontology.js';
import { askCodebase, listAnswers } from '../modules/superpowers/voiceOfCodebase.js';
import { recordOrigin, dig, reconstructByCommit, listDigs } from '../modules/superpowers/archaeology.js';
import { recordSkillSignal, whoKnows, routeReview, listSkillSignals, developerTopSkills } from '../modules/superpowers/taxonomy.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

// ── BLAMELESS ARCHIVIST (#48) ──────────────────────────────────────────────

describe('BLAMELESS ARCHIVIST — archive the full story (#48)', () => {
  beforeEach(cleartables);

  it('archives the complete story and rejects incomplete ones', async () => {
    const pm = await archivePostmortem(USER, {
      title: 'Webhook outage',
      summary: 'webhook deliveries stalled for 40 minutes',
      rootCause: 'race condition in retry loop',
      fix: 'serialized the retry queue',
      timeline: '09:00 first alert',
      prevention: 'add load test for retry storm',
    });
    expect(pm.id).toMatch(/^pst-/);
    expect(pm.title).toBe('Webhook outage');
    expect(pm.incident_id).toBeNull();
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.archived' }));

    await expect(archivePostmortem(USER, { title: 'x', rootCause: 'y', fix: 'z' })).rejects.toThrow(AppError);
  });

  it('re-archiving the same incident updates instead of duplicating', async () => {
    const a = await archivePostmortem(USER, {
      incidentId: 'inc-41',
      title: 'Deploy regression',
      summary: 'v15.0 broke billing',
      rootCause: 'missing migration',
      fix: 'added migration',
    });
    const b = await archivePostmortem(USER, {
      incidentId: 'inc-41',
      title: 'Deploy regression',
      summary: 'v15.0 broke billing, fixed in v15.1',
      rootCause: 'missing migration',
      fix: 'added migration',
    });
    expect(b.id).toBe(a.id);
    expect(b.summary).toBe('v15.0 broke billing, fixed in v15.1');
    expect((await listPostmortems(USER)).length).toBe(1);
  });

  it('lists postmortems newest-first and filters by term', async () => {
    await archivePostmortem(USER, { title: 'Race in retries', summary: 'race condition bug', rootCause: 'concurrent lock', fix: 'add mutex' });
    await archivePostmortem(USER, { title: 'Billing email delay', summary: 'email delivery stalled', rootCause: 'SMTP timeout', fix: 'reconnect' });
    const all = await listPostmortems(USER);
    expect(all.length).toBe(2);
    const filtered = await listPostmortems(USER, { term: 'race' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.title).toBe('Race in retries');
  });

  it('related postmortems surface automatically for a similar problem', async () => {
    await archivePostmortem(USER, { title: 'Race in retries', summary: 'webhook race condition stalls delivery', rootCause: 'concurrent lock', fix: 'add mutex' });
    await archivePostmortem(USER, { title: 'Billing email delay', summary: 'email delivery stalled', rootCause: 'SMTP timeout', fix: 'reconnect' });
    const results = await retrieveRelatedPostmortems(USER, { query: 'webhook race condition' });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain('Race');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.retrieved' }));
  });

  it('retrieval is owner-scoped and empty query returns nothing', async () => {
    await archivePostmortem(OTHER, { title: 'Server crash', summary: 'OOM killed', rootCause: 'memory leak', fix: 'patch' });
    expect((await retrieveRelatedPostmortems(USER, { query: 'server crash' })).length).toBe(0);
    expect((await retrieveRelatedPostmortems(USER, { query: '' })).length).toBe(0);
  });
});

// ── ONTOLOGY ENGINE (#50) ──────────────────────────────────────────────────

describe('ONTOLOGY ENGINE — living domain dictionary (#50)', () => {
  beforeEach(cleartables);

  it('registers a term with aliases and updates by merging', async () => {
    const t = await registerTerm(USER, { canonicalName: 'Customer', aliases: ['User', 'Client'], definition: 'the paying entity' });
    expect(t.id).toMatch(/^ont-/);
    expect(t.aliases).toEqual(['User', 'Client']);
    expect(t.definition).toBe('the paying entity');

    const t2 = await registerTerm(USER, { canonicalName: 'Customer', aliases: ['Member'] });
    expect(t2.id).toBe(t.id);
    expect(new Set(t2.aliases)).toEqual(new Set(['User', 'Client', 'Member']));
    expect(t2.definition).toBe('the paying entity');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'ontology.term_registered' }));
  });

  it('divergence scan flags aliases, ignores canonical, reports unmatched', async () => {
    const term = await registerTerm(USER, { canonicalName: 'Workspace', aliases: ['Organization'] });
    const result = await logTermScan(USER, [
      { name: 'Organization', sourceType: 'API', location: '/v1/orgs' },
      { name: 'Workspace', sourceType: 'UI_COPY', location: 'dashboard' },
      { name: 'Cell', sourceType: 'CODE', location: 'src/x.ts' },
    ]);
    expect(result.counts).toEqual({ observed: 3, canonical: 1, flagged: 1, existing: 0, unmatched: 1 });
    expect(result.flagged.length).toBe(1);
    expect(result.flagged[0]!.used_term).toBe('Organization');
    expect(result.flagged[0]!.term_id).toBe(term.id);
    expect(result.flagged[0]!.source_type).toBe('API');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'ontology.divergence_scanned' }));
  });

  it('scan is idempotent per location and listable/filterable', async () => {
    const term = await registerTerm(USER, { canonicalName: 'Customer', aliases: ['User'] });
    const obs = [{ name: 'User', sourceType: 'CODE' as const, location: 'service.ts' }];
    const first = await logTermScan(USER, obs);
    expect(first.counts.flagged).toBe(1);
    const second = await logTermScan(USER, obs);
    expect(second.counts.existing).toBe(1);
    expect((await listViolations(USER, { status: 'OPEN' })).length).toBe(1);
    expect((await listViolations(USER, { termId: term.id })).length).toBe(1);
  });

  it('resolution accepts or rejects; owner-scoped', async () => {
    const term = await registerTerm(USER, { canonicalName: 'Member', aliases: ['Subscriber'] });
    const { flagged } = await logTermScan(USER, [{ name: 'Subscriber', sourceType: 'UI_COPY', location: 'settings' }]);
    const v1 = flagged[0]!;
    const resolved = await resolveViolation(USER, v1.id, true);
    expect(resolved.status).toBe('APPROVED');
    expect((await listViolations(USER, { status: 'APPROVED' })).length).toBe(1);

    const term2 = await registerTerm(USER, { canonicalName: 'Invoice', aliases: ['Bill'] });
    const { flagged: f2 } = await logTermScan(USER, [{ name: 'Bill', sourceType: 'DOCS', location: 'help.md' }]);
    const resolved2 = await resolveViolation(USER, f2[0]!.id, false);
    expect(resolved2.status).toBe('REJECTED');

    await expect(resolveViolation(OTHER, v1.id, true)).rejects.toThrow(AppError);
  });

  it('unify propagates the agreed canonical name', async () => {
    await registerTerm(USER, { canonicalName: 'Workspace', aliases: ['Organization', 'Org'] });
    await registerTerm(USER, { canonicalName: 'Member', aliases: ['User'] });
    const result = await unifyTerm(USER, { oldName: 'Organization', canonicalName: 'Team' });
    expect(result.terms).toBe(1);
    const terms = await listTerms(USER);
    const workspace = terms.find((t) => t.canonical_name === 'Workspace')!;
    expect(workspace.aliases.some((a) => a.toLowerCase() === 'organization')).toBe(false);
    expect(workspace.aliases).toContain('Team');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'ontology.term_unified' }));
  });
});

// ── VOICE-OF-CODEBASE (#52) ───────────────────────────────────────────────

describe('VOICE-OF-CODEBASE — the codebase talks back (#52)', () => {
  beforeEach(cleartables);

  it('answers who-knows questions with the top developer from real signals', async () => {
    await registerTerm(USER, { canonicalName: 'Billing', aliases: ['Invoice'], definition: 'the money engine' });
    await recordSkillSignal(USER, { developer: 'alex', skill: 'billing', domain: 'payments', weight: 3, source: 'COMMIT' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'billing', weight: 1, source: 'REVIEW' });
    await recordSkillSignal(USER, { developer: 'alex', skill: 'webhooks', weight: 2, source: 'COMMIT' });
    const a = await askCodebase(USER, 'who knows the billing system best?');
    expect(a.id).toMatch(/^cba-/);
    expect(a.answer).toContain('"billing" is best known by alex (weight 3)');
    expect(a.answer).toContain('Billing — the money engine — 0 open violation(s)');
    expect(a.evidence_sources.some((e) => e.kind === 'SKILL')).toBe(true);
    expect(a.evidence_sources.some((e) => e.kind === 'TERM')).toBe(true);
  });

  it('answers term questions with definition and open violation count', async () => {
    const term = await registerTerm(USER, { canonicalName: 'Billing', aliases: ['Invoice'], definition: 'the money engine' });
    await logTermScan(USER, [{ name: 'Invoice', sourceType: 'API', location: '/api/invoices' }]);
    const a = await askCodebase(USER, 'what does the term Billing mean?');
    expect(a.answer).toContain('Billing — the money engine — 1 open violation(s)');
    expect(a.evidence_sources.some((e) => e.kind === 'TERM' && e.refId === term.id)).toBe(true);
  });

  it('answers incident questions from the archive', async () => {
    await archivePostmortem(USER, { title: 'Webhook outage', summary: 'webhook stalled', rootCause: 'retry loop', fix: 'serialize queue' });
    const a = await askCodebase(USER, 'how many incidents are archived?');
    expect(a.answer).toContain('1 incident(s) archived');
    expect(a.answer).toContain('Webhook outage');
    expect(a.evidence_sources.some((e) => e.kind === 'POSTMORTEM')).toBe(true);
  });

  it('honest snapshot fallback and history persistence', async () => {
    const a = await askCodebase(USER, 'how are you feeling today?');
    expect(a.answer).toContain('memory:');
    expect(a.evidence_sources.some((e) => e.kind === 'SNAPSHOT')).toBe(true);

    await archivePostmortem(OTHER, { title: 'X', summary: 'Y', rootCause: 'Z', fix: 'W' });
    const allUser = await listAnswers(USER);
    expect(allUser.length).toBe(1);
    expect((await listAnswers(OTHER)).length).toBe(0);
    expect((await listAnswers(USER, { limit: 1 })).length).toBe(1);
    expect((await listPostmortems(USER)).length).toBe(0);
    expect((await listPostmortems(OTHER)).length).toBe(1);
  });
});

// ── COMMIT ARCHAEOLOGIST (#56) ─────────────────────────────────────────────

describe('COMMIT ARCHAEOLOGIST — reconstruct what happened when (#56)', () => {
  beforeEach(cleartables);

  it('records origin and rejects incomplete records', async () => {
    const r = await recordOrigin(USER, {
      filePath: 'src/billing.ts',
      functionName: 'calculateTotal',
      commit: 'abc123',
      date: '2026-03-10T00:00:00.000Z',
      author: 'alex',
      prSummary: 'v1 pricing',
      context: 'payments freeze decided here',
    });
    expect(r.id).toMatch(/^cma-/);
    expect(r.depth).toBe(1);
    expect(r.first_seen_commit).toBe('abc123');
    expect(r.pr_summary).toBe('v1 pricing');
    expect(r.context).toBe('payments freeze decided here');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.archaeology.recorded' }));

    await expect(recordOrigin(USER, { filePath: '  ', functionName: 'x', commit: 'c', author: 'a' })).rejects.toThrow(AppError);
  });

  it('revisiting deepens the record and keeps first-seen', async () => {
    const r = await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'calculateTotal', commit: 'abc123', author: 'alex', context: 'initial' });
    const r2 = await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'calculateTotal', commit: 'def456', author: 'alex', context: 'V2 adds coupons' });
    expect(r2.id).toBe(r.id);
    expect(r2.depth).toBe(2);
    expect(r2.first_seen_commit).toBe('abc123');
    expect(r2.context).toBe('V2 adds coupons');
  });

  it('dig returns the story with an audit', async () => {
    await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'calculateTotal', commit: 'abc123', author: 'alex' });
    const d = await dig(USER, 'src/billing.ts', 'calculateTotal');
    expect(d.author).toBe('alex');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.archaeology.dug' }));

    await expect(dig(USER, 'missing.ts', 'foo')).rejects.toThrow(AppError);
  });

  it('reconstructs everything that happened in a commit', async () => {
    await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'calculateTotal', commit: 'abc123', author: 'alex' });
    await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'refundTotal', commit: 'abc123', author: 'sam' });
    await recordOrigin(USER, { filePath: 'src/ledger.ts', functionName: 'addEntry', commit: 'xyz', author: 'sam' });
    expect((await reconstructByCommit(USER, 'abc123')).length).toBe(2);
    expect((await reconstructByCommit(USER, 'xyz')).length).toBe(1);
  });

  it('list digs is filterable and owner-scoped', async () => {
    await recordOrigin(USER, { filePath: 'src/billing.ts', functionName: 'calculateTotal', commit: 'abc123', author: 'alex' });
    expect((await listDigs(USER, { term: 'billing' })).length).toBe(1);
    expect((await listDigs(USER, { term: 'coupon' })).length).toBe(0);
    expect((await listDigs(OTHER)).length).toBe(0);
  });
});

// ── SKILL TAXONOMY (#58) ───────────────────────────────────────────────────

describe('SKILL TAXONOMY — who knows what, answered from data (#58)', () => {
  beforeEach(cleartables);

  it('records signals, accumulating weight per (developer, skill, source)', async () => {
    const s1 = await recordSkillSignal(USER, { developer: 'alex', skill: 'billing', domain: 'payments', weight: 2, source: 'COMMIT', evidenceRef: 'pr-1' });
    expect(s1.id).toMatch(/^skt-/);
    expect(s1.weight).toBe(2);
    const s2 = await recordSkillSignal(USER, { developer: 'alex', skill: 'billing', weight: 1, source: 'COMMIT' });
    expect(s2.id).toBe(s1.id);
    expect(s2.weight).toBe(3);

    await expect(recordSkillSignal(USER, { developer: 'x', skill: 'y', weight: 0, source: 'COMMIT' })).rejects.toThrow(AppError);
    await expect(recordSkillSignal(USER, { developer: 'x', skill: 'y', weight: 2, source: 'WRONG' })).rejects.toThrow(AppError);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill.signal_recorded' }));
  });

  it('who-knows ranks developers from summed weights', async () => {
    await recordSkillSignal(USER, { developer: 'alex', skill: 'billing', weight: 3, source: 'COMMIT' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'billing', weight: 1, source: 'REVIEW' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'webhooks', weight: 5, source: 'COMMIT' });
    await recordSkillSignal(USER, { developer: 'zed', skill: 'webhooks', weight: 2, source: 'COMMIT' });

    const billing = await whoKnows(USER, 'billing');
    expect(billing.ranking[0]!.developer).toBe('alex');
    expect(billing.ranking[0]!.weight).toBe(3);
    expect(billing.ranking[1]!.developer).toBe('sam');
    expect(billing.ranking[1]!.weight).toBe(1);

    const webhooks = await whoKnows(USER, 'webhooks');
    expect(webhooks.ranking[0]!.developer).toBe('sam');
    expect(webhooks.ranking[0]!.weight).toBe(5);

    expect((await whoKnows(USER, 'nosuch')).ranking.length).toBe(0);
  });

  it('review routing picks the top signal and records it', async () => {
    await recordSkillSignal(USER, { developer: 'sam', skill: 'webhooks', weight: 5, source: 'COMMIT' });
    const r1 = await routeReview(USER, { skill: 'webhooks', domain: 'payments' });
    expect(r1.recommendation!.developer).toBe('sam');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill.review_routed' }));

    const r2 = await routeReview(USER, { skill: 'nosuch' });
    expect(r2.recommendation).toBeNull();
  });

  it('lists signals with developer/skill filters', async () => {
    await recordSkillSignal(USER, { developer: 'alex', skill: 'billing', weight: 3, source: 'COMMIT' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'billing', weight: 1, source: 'REVIEW' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'webhooks', weight: 5, source: 'COMMIT' });
    await recordSkillSignal(USER, { developer: 'zed', skill: 'webhooks', weight: 2, source: 'COMMIT' });
    expect((await listSkillSignals(USER)).length).toBe(4);
    expect((await listSkillSignals(USER, { developer: 'alex' })).length).toBe(1);
    expect((await listSkillSignals(USER, { skill: 'billing' })).length).toBe(2);
  });

  it('developer profile and owner scoping', async () => {
    await recordSkillSignal(USER, { developer: 'sam', skill: 'billing', weight: 1, source: 'REVIEW' });
    await recordSkillSignal(USER, { developer: 'sam', skill: 'webhooks', weight: 5, source: 'COMMIT' });
    const top = await developerTopSkills(USER, 'sam', 1);
    expect(top.length).toBe(1);
    expect(top[0]!.skill).toBe('webhooks');
    expect(top[0]!.weight).toBe(5);
    expect((await developerTopSkills(OTHER, 'sam')).length).toBe(0);
  });
});