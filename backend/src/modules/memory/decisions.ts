/**
 * CodeConClave — Stage 26B: decision memory (replay + conflict detection).
 *
 * replayDecision: returns the HISTORICAL record when it exists — never a new
 * explanation. If no evidence exists it returns HISTORICAL_EVIDENCE_NOT_FOUND
 * (no hallucination, no generation).
 *
 * detectConflict: deterministic token-overlap matching of a new request
 * against recorded decisions; resolutions (KEEP / REPLACE / EXCEPTION /
 * CANCEL) are recorded with full audit. Replacing a HIGH-impact decision
 * requires an explicit approval flag — never a silent overwrite.
 */
import { pool, queryMany, queryOne } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const DECISION_IMPACTS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DecisionImpact = (typeof DECISION_IMPACTS)[number];

export interface DecisionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  decision: string;
  context: string | null;
  alternatives: string[];
  rationale: string | null;
  consequences: string[];
  source_conversation_id: string | null;
  source_task_id: string | null;
  evidence_ref: string | null;
  impact: DecisionImpact;
  superseded_by_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecordDecisionInput {
  title: string;
  decision: string;
  projectId?: string | null;
  context?: string;
  alternatives?: string[];
  rationale?: string;
  consequences?: string[];
  sourceConversationId?: string | null;
  sourceTaskId?: string | null;
  evidenceRef?: string;
  impact?: DecisionImpact;
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','for','with','from','our','we','to','of','in','on','is','are','was','be','this','that','it','as','at','by','not','no','should','can','will','would','have','has','had','do','does','did','which','what','when','where','how','why','into','over','under','about','after','before','then','than','also','very','just','using','use','used','need','needs','make','makes','made','change','changes','changed','new','old',
]);

export function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP_WORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

/** Deterministic overlap: how many significant tokens the request shares with
 *  a decision's title+decision text. */
export function overlapScore(requestText: string, decision: Pick<DecisionRow, 'title' | 'decision'>): number {
  const req = significantTokens(requestText);
  const dec = significantTokens(`${decision.title} ${decision.decision}`);
  let shared = 0;
  for (const t of req) if (dec.has(t)) shared += 1;
  return shared;
}

export function mapDecision(row: Record<string, unknown>): DecisionRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    project_id: row.project_id === null ? null : String(row.project_id),
    title: String(row.title),
    decision: String(row.decision),
    context: row.context === null ? null : String(row.context),
    alternatives: (row.alternatives as string[]) ?? [],
    rationale: row.rationale === null ? null : String(row.rationale),
    consequences: (row.consequences as string[]) ?? [],
    source_conversation_id: row.source_conversation_id === null ? null : String(row.source_conversation_id),
    source_task_id: row.source_task_id === null ? null : String(row.source_task_id),
    evidence_ref: row.evidence_ref === null ? null : String(row.evidence_ref),
    impact: (row.impact as DecisionImpact) ?? 'MEDIUM',
    superseded_by_id: row.superseded_by_id === null ? null : String(row.superseded_by_id),
    deleted_at: row.deleted_at === null ? null : new Date(String(row.deleted_at)),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

export async function recordDecision(userId: string, input: RecordDecisionInput): Promise<DecisionRow> {
  const title = input.title.trim().slice(0, 200);
  const decision = input.decision.trim().slice(0, 4000);
  if (!title) throw AppError.badRequest('decision_title_required', 'A decision title is required');
  if (!decision) throw AppError.badRequest('decision_required', 'A decision record is required');
  const id = newId(PREFIX.AGENT_DECISION);
  await pool.query(
    `INSERT INTO agent_decisions (id, owner_id, project_id, title, decision, context, alternatives, rationale, consequences,
       source_conversation_id, source_task_id, evidence_ref, impact)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)`,
    [
      id, userId, input.projectId ?? null, title, decision, input.context?.trim().slice(0, 2000) ?? null,
      JSON.stringify((input.alternatives ?? []).slice(0, 20).map(String).slice(0, 1000)),
      input.rationale?.trim().slice(0, 2000) ?? null,
      JSON.stringify((input.consequences ?? []).slice(0, 50).map(String).slice(0, 1000)),
      input.sourceConversationId ?? null, input.sourceTaskId ?? null, input.evidenceRef?.trim().slice(0, 500) ?? null,
      input.impact ?? 'MEDIUM',
    ],
  );
  await recordAudit({
    action: AuditAction.DECISION_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_decisions',
    resourceId: id,
    detail: { title, impact: input.impact ?? 'MEDIUM' },
  });
  const rows = await queryMany<Record<string, unknown>>('SELECT * FROM agent_decisions WHERE id = $1', [id]);
  return mapDecision(rows[0]!);
}

export interface DecisionReplayResult {
  outcome: 'FOUND' | 'HISTORICAL_EVIDENCE_NOT_FOUND';
  decision?: DecisionRow;
}

/** Replay: search recorded decisions by title keywords. NO generation. */
export async function replayDecision(userId: string, query: string): Promise<DecisionReplayResult> {
  const q = query.trim();
  if (!q) throw AppError.badRequest('query_required', 'A query is required');
  const tokens = significantTokens(q);
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM agent_decisions
     WHERE owner_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 200`,
    [userId],
  );
  const decisions = rows.map(mapDecision);
  const best = decisions
    .map((d) => ({ d, score: overlapScore(q, d) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)[0];
  await recordAudit({
    action: AuditAction.DECISION_REPLAYED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_decisions',
    resourceId: best ? best.d.id : null,
    detail: { query: q.slice(0, 200), outcome: best ? 'FOUND' : 'HISTORICAL_EVIDENCE_NOT_FOUND' },
  });
  if (!best) return { outcome: 'HISTORICAL_EVIDENCE_NOT_FOUND' };
  return { outcome: 'FOUND', decision: best.d };
}

export interface ConflictRow {
  id: string;
  owner_id: string;
  decision_id: string;
  request_text: string;
  status: string;
  resolution: string | null;
  note: string | null;
  new_decision_id: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface DetectedConflict {
  conflictId: string;
  affectedDecision: DecisionRow;
  contradiction: string;
  consequence: string[];
}

/** Detect conflicts between a new request and recorded decisions. */
export async function detectConflict(userId: string, requestText: string): Promise<{ conflicts: DetectedConflict[] }> {
  const q = requestText.trim();
  if (!q) return { conflicts: [] };
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM agent_decisions WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    [userId],
  );
  const conflicts: DetectedConflict[] = [];
  for (const d of rows.map(mapDecision)) {
    if (overlapScore(q, d) >= 3) {
      const conflictId = newId(PREFIX.DECISION_CONFLICT);
      await pool.query(
        `INSERT INTO decision_conflicts (id, owner_id, decision_id, request_text, status)
         VALUES ($1,$2,$3,$4,'OPEN')`,
        [conflictId, userId, d.id, q.slice(0, 1000)],
      );
      conflicts.push({
        conflictId,
        affectedDecision: d,
        contradiction: `The request contradicts the recorded decision "${d.title}" (${d.created_at.toISOString()}).`,
        consequence: d.consequences,
      });
    }
  }
  if (conflicts.length > 0) {
    await recordAudit({
      action: AuditAction.DECISION_CONFLICT_RESOLVED, // recorded at detection for visibility; resolution adds detail below
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'decision_conflicts',
      resourceId: null,
      detail: { detected: conflicts.length, request: q.slice(0, 200) },
    });
  }
  return { conflicts };
}

export interface ResolveConflictInput {
  resolution: 'KEEP' | 'REPLACE' | 'EXCEPTION' | 'CANCEL';
  note?: string;
  approved?: boolean;
  replacement?: RecordDecisionInput;
}

/** Record the user's resolution. REPLACE requires an approved replacement
 *  decision; replacing a HIGH-impact decision requires approval explicitly. */
export async function resolveConflict(userId: string, conflictId: string, input: ResolveConflictInput): Promise<ConflictRow> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM decision_conflicts WHERE id = $1 AND owner_id = $2 AND status = \'OPEN\'',
    [conflictId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Open conflict');
  const conflict = rows[0];
  const decisionRows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM agent_decisions WHERE id = $1 AND owner_id = $2',
    [String(conflict.decision_id), userId],
  );
  const decision = decisionRows[0] ? mapDecision(decisionRows[0]) : null;

  let newDecisionId: string | null = null;
  if (input.resolution === 'REPLACE') {
    if (!input.replacement) throw AppError.badRequest('replacement_required', 'REPLACE requires a replacement decision');
    if (decision?.impact === 'HIGH' && input.approved !== true) {
      throw AppError.conflict('approval_required', 'Replacing a HIGH-impact decision requires explicit approval');
    }
    const created = await recordDecision(userId, { ...input.replacement, sourceTaskId: decision?.source_task_id ?? null });
    newDecisionId = created.id;
    await pool.query('UPDATE agent_decisions SET superseded_by_id = $1, updated_at = now() WHERE id = $2', [created.id, decision?.id ?? conflict.decision_id]);
  }

  await pool.query(
    `UPDATE decision_conflicts SET status = 'RESOLVED', resolution = $1, note = $2, new_decision_id = $3, resolved_at = now()
     WHERE id = $4`,
    [input.resolution, input.note?.trim().slice(0, 2000) ?? null, newDecisionId, conflictId],
  );
  await recordAudit({
    action: AuditAction.DECISION_CONFLICT_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'decision_conflicts',
    resourceId: conflictId,
    detail: { resolution: input.resolution, newDecisionId, note: input.note?.slice(0, 200) ?? null },
  });
  const after = await queryMany<Record<string, unknown>>('SELECT * FROM decision_conflicts WHERE id = $1', [conflictId]);
  return mapConflict(after[0]!);
}

function mapConflict(row: Record<string, unknown>): ConflictRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    decision_id: String(row.decision_id),
    request_text: String(row.request_text),
    status: String(row.status),
    resolution: row.resolution === null ? null : String(row.resolution),
    note: row.note === null ? null : String(row.note),
    new_decision_id: row.new_decision_id === null ? null : String(row.new_decision_id),
    resolved_at: row.resolved_at === null ? null : new Date(String(row.resolved_at)),
    created_at: new Date(String(row.created_at)),
  };
}

export async function listConflicts(userId: string, status?: string): Promise<ConflictRow[]> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM decision_conflicts WHERE owner_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY created_at DESC LIMIT 50`,
    status ? [userId, status] : [userId],
  );
  return rows.map(mapConflict);
}

export async function listDecisions(userId: string, projectId?: string): Promise<DecisionRow[]> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM agent_decisions WHERE owner_id = $1 AND deleted_at IS NULL ${projectId ? 'AND project_id = $2' : ''} ORDER BY created_at DESC LIMIT 100`,
    projectId ? [userId, projectId] : [userId],
  );
  return rows.map(mapDecision);
}

export async function getDecision(userId: string, decisionId: string): Promise<DecisionRow> {
  const rows = await queryMany<Record<string, unknown>>('SELECT * FROM agent_decisions WHERE id = $1 AND owner_id = $2', [decisionId, userId]);
  if (!rows[0]) throw AppError.notFound('Decision');
  return mapDecision(rows[0]);
}