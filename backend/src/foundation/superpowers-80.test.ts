/**
 * CodeConClave — Stage 80 SUPERPOWERS (realtime autonomy branch): service suite.
 *
 * Covers the three instant-wins features as genuine, owner-scoped logic:
 *   LIVE DIFF WATCH     (#67): append-only agent event log; ordered seq cursor;
 *                     cursor/limit streaming; mid-task comments that the
 *                     coworker consumes (source_uid recorded).
 *   AUTO-FIX INBOX      (#69): every CI/Sentry/preview/deploy failure becomes a
 *                     fix ticket with a strict OPEN -> IN_REPRODUCTION ->
 *                     FIX_PROPOSED -> PR_OPENED -> RESOLVED pipeline and an
 *                     enforced transition graph (invalid transitions fail).
 *   INTENTION COMPLETION (#59): a comment describing intent produces a working
 *                     generated draft (function + params + JSDoc + test
 *                     snippet) plus the marker that deletes the comment, then
 *                     applies or dismisses; generation is deterministic.
 *
 * DB (pool/queryMany/queryOne) + audit + ids are mocked; ALL service logic runs
 * real. The mock now supports bigserial seq (RETURNING seq), comparison
 * operators in WHERE (seq > $N) and numeric ORDER BY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// hoisted in-memory store + db mock (self-contained)
// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  const tables = {
    agent_events: [] as Array<Record<string, unknown>>,
    fix_tickets: [] as Array<Record<string, unknown>>,
    intent_drafts: [] as Array<Record<string, unknown>>,
    proof_claims: [] as Array<Record<string, unknown>>,
  };
  let nextSeq = 1;
  return { tables, nextSeq: () => nextSeq++, now: () => new Date().toISOString() };
});

const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn(async () => {}) }));

const dbMock = vi.hoisted(() => {
  function jsonbCols(col: string): boolean {
    return ['payload', 'generated', 'manifest', 'why_trace', 'evidence'].includes(col);
  }
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '').replace(/[`"']/g, '');
  }
  function now(): string {
    return new Date().toISOString();
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text;
    const lq = q.toLowerCase().trim();
    const params = rawParams.map((p) => p);

    // ------------------------------------------------------------ INSERT
    const ins = /insert into (\w+)\s*\(([^\\)]+)\)\s*values\s*\((.*)\)/is.exec(q);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables];
      const row: Record<string, unknown> = { created_at: now(), updated_at: now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1])! - 1];
          row[col] = jsonbCols(col) && typeof val === 'string' ? JSON.parse(val) : val;
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.startsWith("'") && tok.endsWith("'")) {
          row[col] = tok.slice(1, -1);
        }
      });
      if (table === 'agent_events') { row.seq = store.nextSeq(); row.run_id ??= null; }
      if (table === 'fix_tickets') { if (row.status === undefined) row.status = 'OPEN'; }
      if (table === 'intent_drafts') { if (row.status === undefined) row.status = 'DRAFT'; }
      storeRows.push(row);
      if (/returning seq/i.test(q)) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }

    // ------------------------------------------------------------ DELETE
    if (/^delete from \w+/.test(lq)) {
      const table = /^delete from (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables];
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(q);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(q);
      const idVal = idRef ? String(params[Number(idRef[1])! - 1]) : null;
      const target = idVal === null ? null : rows.find((r) => r.id === idVal) ?? null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) {
        return { rows: [], rowCount: 0 };
      }
      if (target) { const idx = rows.indexOf(target); rows.splice(idx, 1); }
      return { rows: [], rowCount: target ? 1 : 0 };
    }

    // ------------------------------------------------------------ UPDATE
    if (/^update \w+/.test(lq)) {
      const table = /^update (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const setMatch = /set\s+(.+?)\s+where/is.exec(q);
      const whereMatch = /where\s+(.+)/is.exec(q);
      if (!setMatch || !whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1])! - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) {
        return { rows: [], rowCount: 0 };
      }
      const pairs = setMatch[1]!.split(',').map((s) => s.trim());
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        const col = cleanCol(pair.slice(0, eq));
        const ref = pair.slice(eq + 1).trim();
        const dollar = /\$(\d+)/.exec(ref);
        if (col === 'updated_at') { target![col] = now(); continue; }
        if (dollar) {
          const val = params[Number(dollar[1])! - 1];
          target![col] = jsonbCols(col) && typeof val === 'string' ? JSON.parse(val) : val;
          continue;
        }
        if (ref.toLowerCase() === 'now()') { target![col] = now(); continue; }
        if (ref.startsWith("'") && ref.endsWith("'")) { target![col] = ref.slice(1, -1); continue; }
        if (ref.toUpperCase() === 'NULL') { target![col] = null; continue; }
      }
      return { rows: [target!], rowCount: 1 };
    }

    // ------------------------------------------------------------ generic select *
    if (/select \*/.test(lq)) {
      const tableMatch = /from (\w+)/i.exec(q);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const idMatch = /\bid\s*=\s*\$(\d+)/i.exec(q);
      if (idMatch && !/owner_id/i.test(idMatch[0])) {
        const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(q);
        const hit = rows.filter((r) => {
          if (String(r.id) !== String(params[Number(idMatch[1])! - 1])) return false;
          if (ownerRef && String(r.owner_id ?? '') !== String(params[Number(ownerRef[1])! - 1])) return false;
          return true;
        });
        return { rows: hit, rowCount: hit.length };
      }
      let filtered = [...rows];
      const whereMatch = /where\s+(.+?)(?:\s+group by|\s+order by|$)/is.exec(q);
      if (whereMatch) {
        const where = whereMatch[1]!;
        const operators: Array<[RegExp, (a: unknown, b: unknown, op: string) => boolean]> = [
          [/^(\w+)\s*=\s*\$(\d+)$/i, (a, b) => String(a ?? '') === String(b ?? '')],
          [/^(\w+)\s*(>=|<=|>|<)\s*\$(\d+)$/i, (a, b, op) => {
            const an = Number(a); const bn = Number(b);
            if (op === '>') return an > bn;
            if (op === '<') return an < bn;
            if (op === '>=') return an >= bn;
            if (op === '<=') return an <= bn;
            return false;
          }],
        ];
        for (const clause of where.split(/\s+(?:AND|and)\s+/)) {
          const trimmed = clause.trim();
          let applied = false;
          for (const [re, fn] of operators) {
            const m = re.exec(trimmed);
            if (!m) continue;
            const col = cleanCol(m[1]!);
            const digit = m[3] ?? m[2];
            const val = params[Number(digit) - 1];
            filtered = filtered.filter((r) => fn(r[col], val, m[2] ?? '='));
            applied = true;
            break;
          }
          if (!applied && /^(\w+)\s*=\s*\$(\d+)$/i.test(trimmed)) {
            const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(trimmed)!;
            const val = params[Number(m[2]!) - 1];
            filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
          }
        }
      }
      const limitMatch = /limit \$(\d+)/i.exec(q);
      if (limitMatch) {
        const lim = Number(params[Number(limitMatch[1])! - 1]) || 0;
        filtered = filtered.slice(0, lim);
      }
      const orderMatch = /order by\s+(.*?)(?:\s+limit|$)/is.exec(q);
      if (orderMatch) {
        const dir = /desc/i.test(orderMatch[1]!) ? -1 : 1;
        const col = cleanCol(orderMatch[1]!.split(/\s+/)[0]!);
        filtered.sort((a, b) => {
          const av = a[col]; const bv = b[col];
          if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
          return dir * String(av ?? '').localeCompare(String(bv ?? ''));
        });
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows),
    queryOne: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: { AGENT_EVENT: 'aev', FIX_TICKET: 'fxt', INTENT_DRAFT: 'ind' },
  newId: (p: string) => `id-${p}-${Math.random().toString(36).slice(2, 8)}`,
}));

// ---------------------------------------------------------------------------
import {
  appendAgentEvent, streamAgentEvents, commentOnDiff, getAgentEvent, AgentEventKind,
} from '../modules/superpowers/live.js';
import {
  createFixTicket, getFixTicket, listFixTickets, startReproduction, proposeFix, resolveFix, supersedeFix,
} from '../modules/superpowers/fixes.js';
import {
  generateIntentDraft, getIntentDraft, listIntentDrafts, applyIntentDraft, dismissIntentDraft, generateFromIntent,
} from '../modules/superpowers/intent.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';
const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

describe('LIVE DIFF WATCH (#67)', () => {
  beforeEach(cleartables);

  it('appends a file_changed event with its diff patch and a monotonically increasing seq', async () => {
    const e1 = await appendAgentEvent(USER, {
      taskId: 'task-1', runId: 'run-1', kind: AgentEventKind.FILE_CHANGED, path: 'src/app.ts', patch: '+new line',
    });
    const e2 = await appendAgentEvent(USER, {
      taskId: 'task-1', kind: AgentEventKind.FILE_CHANGED, path: 'src/app.ts', patch: '+another',
    });
    expect(e1.seq).toBeLessThan(e2.seq);
    expect(e1.kind).toBe('file_changed');
    expect(e1.path).toBe('src/app.ts');
    expect(e2.seq).toBe(e1.seq + 1);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_event.appended', resourceId: e1.id }));
  });

  it('rejects an unknown event kind (fail closed)', async () => {
    await expect(appendAgentEvent(USER, { taskId: 'task-1', kind: 'exploded' as never })).rejects.toThrow(AppError);
    expect(store.tables.agent_events.length).toBe(0);
  });

  it('streams only events AFTER the cursor and honors the limit', async () => {
    for (let i = 0; i < 6; i += 1) {
      await appendAgentEvent(USER, { taskId: 'task-9', kind: AgentEventKind.FILE_CHANGED, path: `f-${i}`, patch: `+${i}` });
    }
    const limited = await streamAgentEvents(USER, 'task-9', { limit: 3 });
    expect(limited.map((e) => e.path)).toEqual(['f-0', 'f-1', 'f-2']);
    const after3 = await streamAgentEvents(USER, 'task-9', { afterSeq: limited[2]!.seq });
    expect(after3.length).toBe(3);
    expect(after3[0]!.path).toBe('f-3');
  });

  it('commenting on a live diff records a COMMENT event authored by the user', async () => {
    await appendAgentEvent(USER, { taskId: 'task-1', kind: AgentEventKind.FILE_CHANGED, path: 'src/x.ts', patch: '+a' });
    const comment = await commentOnDiff(USER, { taskId: 'task-1', path: 'src/x.ts', comment: 'wrap this in try/catch' });
    expect(comment.kind).toBe('comment');
    expect(comment.source_uid).toBe(USER);
    expect(comment.payload.comment).toBe('wrap this in try/catch');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_diff.commented' }));
  });

  it('is tenant-scoped: another user cannot read your events', async () => {
    const e = await appendAgentEvent(USER, { taskId: 'task-1', kind: AgentEventKind.TASK_CREATED });
    await expect(getAgentEvent(OTHER, e.id)).rejects.toThrow(AppError);
    expect(await streamAgentEvents(OTHER, 'task-1')).toEqual([]);
  });
});

describe('AUTO-FIX INBOX (#69)', () => {
  beforeEach(cleartables);

  it('creates an OPEN ticket from a CI failure and audits it', async () => {
    const t = await createFixTicket(USER, { source: 'ci_failure', issue: 'lint crashed on PR 42', ref: 'gh:42' });
    expect(t.status).toBe('OPEN');
    expect(t.source).toBe('ci_failure');
    expect(t.ref).toBe('gh:42');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'fix_ticket.created', resourceId: t.id }));
  });

  it('requires an issue and a known source', async () => {
    await expect(createFixTicket(USER, { source: 'ci_failure', issue: '  ' })).rejects.toThrow(AppError);
    await expect(createFixTicket(USER, { source: 'telepathy' as never, issue: 'x' })).rejects.toThrow(AppError);
  });

  it('CLICK -> reproduce: OPEN to IN_REPRODUCTION', async () => {
    const t = await createFixTicket(USER, { source: 'deploy_failed', issue: 'rollout 17 failed' });
    const started = await startReproduction(USER, t.id);
    expect(started.status).toBe('IN_REPRODUCTION');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'fix_ticket.started' }));
  });

  it('fix with proof: a proof-only proposal stays FIX_PROPOSED; adding the PR opens it', async () => {
    const t = await createFixTicket(USER, { source: 'ci_failure', issue: 'broken test' });
    await startReproduction(USER, t.id);
    const proofOnly = await proposeFix(USER, t.id, { proofClaimId: 'pcl-1' });
    expect(proofOnly.status).toBe('FIX_PROPOSED');
    expect(proofOnly.proof_claim_id).toBe('pcl-1');
    const prOpen = await proposeFix(USER, t.id, { proofClaimId: 'pcl-1', prUrl: 'https://github.com/x/pr/9' });
    expect(prOpen.status).toBe('PR_OPENED');
    expect(prOpen.pr_url).toBe('https://github.com/x/pr/9');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'fix_ticket.proposed' }));
  });

  it('enforces the transition graph: you cannot resolve an OPEN ticket', async () => {
    const t = await createFixTicket(USER, { source: 'manual', issue: 'nope' });
    await expect(resolveFix(USER, t.id)).rejects.toThrow(AppError);
    expect(t.status).toBe('OPEN');
  });

  it('ships the full happy path: reproduce -> fix -> PR -> RESOLVED and supersede obsolete tickets', async () => {
    const t = await createFixTicket(USER, { source: 'preview_broken', issue: 'preview 404s' });
    await startReproduction(USER, t.id);
    await proposeFix(USER, t.id, { proofClaimId: 'pcl-2', prUrl: 'https://pr/1' });
    const prOpen = await getFixTicket(USER, t.id);
    expect(prOpen.status).toBe('PR_OPENED');
    expect(prOpen.proof_claim_id).toBe('pcl-2');
    const resolved = await resolveFix(USER, t.id, 'https://pr/1');
    expect(resolved.status).toBe('RESOLVED');

    const stale = await createFixTicket(USER, { source: 'ci_failure', issue: 'obsolete build 9000' });
    const superseded = await supersedeFix(USER, stale.id);
    expect(superseded.status).toBe('SUPERSEDED');
    // RESOLVED is terminal: the old ticket cannot be touched again.
    await expect(supersedeFix(USER, resolved.id)).rejects.toThrow(AppError);
    const open = (await listFixTickets(USER, { status: 'OPEN' })).filter((r) => r.id !== t.id);
    expect(open).toEqual([]);
  });

  it('filters tickets by status and source', async () => {
    await createFixTicket(USER, { source: 'ci_failure', issue: 'a' });
    await createFixTicket(USER, { source: 'ci_failure', issue: 'b' });
    await createFixTicket(USER, { source: 'deploy_failed', issue: 'c' });
    const onlyCi = await listFixTickets(USER, { source: 'ci_failure' });
    expect(onlyCi.length).toBe(2);
    const onlyDeploysOpen = await listFixTickets(USER, { status: 'OPEN', source: 'deploy_failed' });
    expect(onlyDeploysOpen.length).toBe(1);
  });
});

describe('INTENTION COMPLETION (#59)', () => {
  beforeEach(cleartables);

  it('turns an intent comment into a named, documented, testable draft', async () => {
    const draft = await generateIntentDraft(USER, {
      file: 'src/age.ts', intent: 'Calculate user age at signup and flag if underage', language: 'typescript',
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.generated.functionName).toBe('calculateUserAgeSignup');
    expect(draft.generated.returns).toBe('boolean');
    expect(draft.generated.jsdoc).toContain('Calculate user age at signup');
    expect(draft.generated.testSnippet).toContain("expect(typeof calculateUserAgeSignup).toBe('function')");
    expect(draft.comment_marker).toBeTruthy();
    expect(draft.language).toBe('typescript');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'intent_draft.generated' }));
  });

  it('generation is deterministic for identical input', () => {
    const a = generateFromIntent('Calculate user age at signup and flag if underage', 'javascript');
    const b = generateFromIntent('Calculate user age at signup and flag if underage', 'javascript');
    expect(a).toEqual(b);
    expect(a.functionName).toBe('calculateUserAgeSignup');
  });

  it('requires a file and an intent', async () => {
    await expect(generateIntentDraft(USER, { file: '', intent: 'do something' })).rejects.toThrow(AppError);
    await expect(generateIntentDraft(USER, { file: 'a.ts', intent: '  ' })).rejects.toThrow(AppError);
  });

  it('apply keeps the comment marker, marks APPLIED and never double-applies', async () => {
    const draft = await generateIntentDraft(USER, { file: 'src/age.ts', intent: 'flag underage users' });
    const applied = await applyIntentDraft(USER, draft.id);
    expect(applied.status).toBe('APPLIED');
    expect(applied.comment_marker).toBe(draft.comment_marker);
    const again = await applyIntentDraft(USER, draft.id);
    expect(again.status).toBe('APPLIED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'intent_draft.applied' }));
  });

  it('lists drafts by status and dismisses instead of applying', async () => {
    await generateIntentDraft(USER, { file: 'a.ts', intent: 'keep me' });
    const d2 = await generateIntentDraft(USER, { file: 'b.ts', intent: 'dismiss me' });
    await dismissIntentDraft(USER, d2.id);
    expect((await getIntentDraft(USER, d2.id)).status).toBe('DISMISSED');
    const drafts = await listIntentDrafts(USER, { status: 'DRAFT' });
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.file).toBe('a.ts');
  });

  it('is tenant-scoped: another user cannot read your draft', async () => {
    const draft = await generateIntentDraft(USER, { file: 'a.ts', intent: 'secret plan' });
    await expect(getIntentDraft(OTHER, draft.id)).rejects.toThrow(AppError);
    expect(await listIntentDrafts(OTHER)).toEqual([]);
  });
});
