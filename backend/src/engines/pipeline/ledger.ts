/**
 * Ledger & policy — one ledger, one truth. Every stage write is a hash-linked
 * event on the run (parent hash on every event, append-only); a tampered link
 * breaks verification visibly. Runs, events and the answer cache are
 * owner-scoped under RLS. If the ledger can't be written the pipeline fails
 * closed (the offline rule) instead of answering unverified.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { canonicalJson } from '../../modules/audit/chain.js';

export type RunStatus = 'RUNNING' | 'KNOWN' | 'VERIFIED' | 'UNVERIFIED' | 'CACHED' | 'DENIED' | 'ESCALATED' | 'NEEDS_BUDGET' | 'HALTED' | 'FAILED';

export interface RunScope {
  ownerId: string;
  projectId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  deviceId?: string | null;
}

export interface NewRun extends RunScope {
  questionHash: string;
  fileHash: string;
  dnaVersion: string;
  cacheKey: string;
  budgetTier: string;
  budgetTokens: number;
}

/** In-memory chain cursor for one run (the run has a single writer). */
export interface ChainCursor {
  runId: string;
  ownerId: string;
  seq: number;
  head: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function eventHash(parent: string, seq: number, stage: string, payload: unknown): string {
  return sha256(`${parent}|${seq}|${stage}|${canonicalJson(payload)}`);
}

export async function createRun(run: NewRun): Promise<ChainCursor> {
  const id = newId('run');
  await withTenant(run.ownerId, (q) =>
    q.query(
      `INSERT INTO pipeline_runs (id, owner_id, project_id, conversation_id, task_id, device_id, question_hash, file_hash,
         dna_version, cache_key, budget_tier, budget_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, run.ownerId, run.projectId ?? null, run.conversationId ?? null, run.taskId ?? null, run.deviceId ?? null, run.questionHash, run.fileHash, run.dnaVersion, run.cacheKey, run.budgetTier, run.budgetTokens],
    ),
  );
  return { runId: id, ownerId: run.ownerId, seq: 0, head: `GENESIS:${id}` };
}

/** Append one hash-linked event; advances the cursor. Throws if the ledger is offline. */
export async function appendEvent(cur: ChainCursor, stage: string, payload: Record<string, unknown>): Promise<string> {
  const seq = cur.seq + 1;
  const hash = eventHash(cur.head, seq, stage, payload);
  await withTenant(cur.ownerId, (q) =>
    q.query(
      `INSERT INTO pipeline_events (run_id, seq, stage, payload, parent_hash, event_hash) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [cur.runId, seq, stage, JSON.stringify(payload), cur.head, hash],
    ),
  );
  cur.seq = seq;
  cur.head = hash;
  return hash;
}

export async function updateRun(cur: ChainCursor, patch: Partial<{ lane: string; risk: string; role: string; driver: string; contractVersion: string; attempts: number; tokensUsed: number }>): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = { lane: 'lane', risk: 'risk', role: 'role', driver: 'driver', contractVersion: 'contract_version', attempts: 'attempts', tokensUsed: 'tokens_used' };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    cols.push(`${map[k]} = $${vals.length + 1}`);
  }
  if (!cols.length) return;
  await withTenant(cur.ownerId, (q) => q.query(`UPDATE pipeline_runs SET ${cols.join(', ')} WHERE id = $1`, [cur.runId, ...vals]));
}

export async function sealRun(cur: ChainCursor, status: RunStatus, proofHash: string | null, receipt: Record<string, unknown>, tokensUsed: number): Promise<void> {
  await withTenant(cur.ownerId, (q) =>
    q.query(
      `UPDATE pipeline_runs SET status = $2, proof_hash = $3, head_hash = $4, receipt = $5::jsonb, tokens_used = $6, sealed_at = now() WHERE id = $1`,
      [cur.runId, status, proofHash, cur.head, JSON.stringify(receipt), tokensUsed],
    ),
  );
}

// ---------------------------------------------------------------- reads

export interface RunRow {
  id: string;
  status: RunStatus;
  role: string | null;
  lane: string | null;
  risk: string | null;
  driver: string | null;
  contract_version: string | null;
  attempts: number;
  tokens_used: number;
  budget_tokens: number;
  budget_tier: string;
  proof_hash: string | null;
  head_hash: string | null;
  receipt: Record<string, unknown> | null;
  project_id: string | null;
  conversation_id: string | null;
  created_at: Date;
  sealed_at: Date | null;
}

export interface EventRow {
  seq: number;
  stage: string;
  payload: Record<string, unknown>;
  parent_hash: string;
  event_hash: string;
  created_at: Date;
}

export async function getRun(ownerId: string, runId: string): Promise<{ run: RunRow; events: EventRow[] } | null> {
  return withTenant(ownerId, async (q) => {
    const run = (await q.query<RunRow>('SELECT * FROM pipeline_runs WHERE id = $1 AND owner_id = $2', [runId, ownerId])).rows[0];
    if (!run) return null;
    const events = (await q.query<EventRow>('SELECT seq, stage, payload, parent_hash, event_hash, created_at FROM pipeline_events WHERE run_id = $1 ORDER BY seq', [runId])).rows;
    return { run, events };
  });
}

export async function listRuns(ownerId: string, opts: { status?: RunStatus; limit?: number } = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withTenant(ownerId, async (q) =>
    (
      await q.query<RunRow>(
        `SELECT * FROM pipeline_runs WHERE owner_id = $1 ${opts.status ? 'AND status = $3' : ''} ORDER BY created_at DESC LIMIT $2`,
        opts.status ? [ownerId, limit, opts.status] : [ownerId, limit],
      )
    ).rows,
  );
}

/** Recompute the run's event chain; any edited, removed or re-linked event shows. */
export function verifyEvents(runId: string, events: EventRow[], headHash: string | null): { ok: boolean; checked: number; brokenAt: number | null } {
  let parent = `GENESIS:${runId}`;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.seq !== i + 1 || e.parent_hash !== parent || eventHash(parent, e.seq, e.stage, e.payload) !== e.event_hash) {
      return { ok: false, checked: i, brokenAt: e.seq };
    }
    parent = e.event_hash;
  }
  if (headHash && headHash !== parent) return { ok: false, checked: events.length, brokenAt: events.length + 1 };
  return { ok: true, checked: events.length, brokenAt: null };
}

// ---------------------------------------------------------------- answer cache

export async function cacheGet(ownerId: string, key: string): Promise<{ finalText: string; receipt: Record<string, unknown>; runId: string | null } | null> {
  return withTenant(ownerId, async (q) => {
    const row = (
      await q.query<{ final_text: string; receipt: Record<string, unknown>; run_id: string | null }>(
        `UPDATE pipeline_answer_cache SET hits = hits + 1
          WHERE cache_key = $1 AND owner_id = $2 AND expires_at > now()
          RETURNING final_text, receipt, run_id`,
        [key, ownerId],
      )
    ).rows[0];
    return row ? { finalText: row.final_text, receipt: row.receipt, runId: row.run_id } : null;
  });
}

export async function cachePut(ownerId: string, key: string, runId: string, finalText: string, receipt: Record<string, unknown>, ttlHours: number): Promise<void> {
  await withTenant(ownerId, (q) =>
    q.query(
      `INSERT INTO pipeline_answer_cache (cache_key, owner_id, run_id, final_text, receipt, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb, now() + make_interval(hours => $6))
       ON CONFLICT (cache_key) DO UPDATE SET run_id = EXCLUDED.run_id, final_text = EXCLUDED.final_text,
         receipt = EXCLUDED.receipt, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [key, ownerId, runId, finalText, JSON.stringify(receipt), ttlHours],
    ),
  );
}

/** Project DNA version: a hash of every live DNA block's id and version. */
export async function dnaVersion(ownerId: string, projectId: string | null | undefined): Promise<string> {
  if (!projectId) return 'none';
  const rows = await withTenant(ownerId, async (q) =>
    (await q.query<{ id: string; version: number }>('SELECT id, version FROM dna WHERE project_id = $1 AND deleted_at IS NULL ORDER BY id', [projectId])).rows,
  );
  return rows.length ? sha256(rows.map((r) => `${r.id}:${r.version}`).join('|')).slice(0, 16) : 'empty';
}
