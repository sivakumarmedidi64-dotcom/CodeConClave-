/**
 * CodeConClave — Superpowers: PROOF-OF-RUN (Master Feature #34, #70, #71).
 *
 * Law 1 of the product: an agent claim is not "done" without executable
 * evidence. The server computes the verdict from the attached evidence kind +
 * reference — the caller can never self-certify:
 *
 *   - no evidence_ref                       -> UNVERIFIED (fail closed)
 *   - evidence_kind TEST_RUN + ref          -> VERIFIED
 *   - BENCHMARK / ARTIFACT / SCREENSHOT / LOG -> PARTIAL
 *
 * Every claim keeps an append-only WHY trace (the reasoning / files the claim
 * was built on) so the UI can expose a "Why?" button and a VERIFIED / PARTIAL /
 * UNVERIFIED proof badge. All transitions are audited.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const EvidenceKind = ['NONE', 'TEST_RUN', 'BENCHMARK', 'LOG', 'ARTIFACT', 'SCREENSHOT'] as const;
export type EvidenceKind = (typeof EvidenceKind)[number];
export const ClaimVerdict = ['UNVERIFIED', 'PARTIAL', 'VERIFIED'] as const;
export type ClaimVerdict = (typeof ClaimVerdict)[number];

export interface ProofClaimInput {
  claim: string;
  subject?: string;
  projectId?: string | null;
  taskId?: string | null;
  evidenceKind?: EvidenceKind;
  evidenceRef?: string | null;
  whyTrace?: string[];
}

export interface ProofClaimRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  task_id: string | null;
  claim: string;
  subject: string | null;
  evidence_kind: EvidenceKind;
  evidence_ref: string | null;
  verdict: ClaimVerdict;
  why_trace: string[];
  created_at: Date;
  updated_at: Date;
}

/** Server-authoritative verdict. Evidence decides; the caller cannot. */
export function computeVerdict(kind: EvidenceKind, ref: string | null | undefined): ClaimVerdict {
  // Law: NONE (no evidence attached) or a missing reference is NEVER verified.
  if (kind === 'NONE' || !ref) return 'UNVERIFIED';
  if (kind === 'TEST_RUN') return 'VERIFIED';
  return 'PARTIAL';
}

function rowOf(r: Record<string, unknown>): ProofClaimRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    task_id: r.task_id === null ? null : String(r.task_id),
    claim: String(r.claim),
    subject: r.subject === null ? null : String(r.subject),
    evidence_kind: (r.evidence_kind as EvidenceKind) ?? 'NONE',
    evidence_ref: r.evidence_ref === null ? null : String(r.evidence_ref),
    verdict: (r.verdict as ClaimVerdict) ?? 'UNVERIFIED',
    why_trace: Array.isArray(r.why_trace) ? (r.why_trace as string[]) : [],
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

function normalizeKind(value: string | null | undefined): EvidenceKind {
  const v = (value ?? 'NONE').toUpperCase();
  return (EvidenceKind as readonly string[]).includes(v) ? (v as EvidenceKind) : 'NONE';
}

/** Register a claim. Its verdict is UNVERIFIED until evidence is attached —
 *  that is the Proof-of-Run law, enforced at creation. */
export async function registerClaim(userId: string, input: ProofClaimInput): Promise<ProofClaimRow> {
  const claim = (input.claim ?? '').trim();
  if (!claim) throw AppError.badRequest('claim_required', 'A claim statement is required');
  const kind = normalizeKind(input.evidenceKind);
  const ref = input.evidenceRef?.trim() || null;
  const id = newId(PREFIX.PROOF_CLAIM);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO proof_claims (id, owner_id, project_id, task_id, claim, subject, evidence_kind, evidence_ref, verdict, why_trace)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        id, userId, input.projectId ?? null, input.taskId ?? null, claim,
        input.subject?.trim()?.slice(0, 300) ?? null, kind, ref, computeVerdict(kind, ref),
        JSON.stringify((input.whyTrace ?? []).map(String).slice(0, 50)),
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.PROOF_CLAIM_REGISTERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'proof_claims',
    resourceId: id,
    detail: { claim: claim.slice(0, 200), verdict: computeVerdict(kind, ref), taskId: input.taskId ?? null },
  });
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM proof_claims WHERE id = $1', [id])).rows,
  );
  return rowOf(rows[0]!);
}

export async function attachEvidence(
  userId: string,
  claimId: string,
  input: { evidenceKind: EvidenceKind; evidenceRef: string; whyTrace?: string[] },
): Promise<ProofClaimRow> {
  const existing = await getClaim(userId, claimId);
  const kind = normalizeKind(input.evidenceKind);
  const ref = (input.evidenceRef ?? '').trim();
  if (!ref) throw AppError.badRequest('evidence_ref_required', 'An evidence reference is required');
  const verdict = computeVerdict(kind, ref);
  const why = [...existing.why_trace, ...(input.whyTrace ?? []).map(String).slice(0, 40)].slice(-100);
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE proof_claims
         SET evidence_kind = $2, evidence_ref = $3, verdict = $4, why_trace = $5::jsonb, updated_at = now()
       WHERE id = $1 AND owner_id = $6`,
      [claimId, kind, ref, verdict, JSON.stringify(why), userId],
    ),
  );
  await recordAudit({
    action: AuditAction.PROOF_EVIDENCE_ATTACHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'proof_claims',
    resourceId: claimId,
    detail: { kind, ref: ref.slice(0, 300), verdict },
  });
  return getClaim(userId, claimId);
}

export async function getClaim(userId: string, claimId: string): Promise<ProofClaimRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM proof_claims WHERE id = $1 AND owner_id = $2',
      [claimId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Proof claim');
  return rowOf(rows[0]);
}

export async function listClaims(
  userId: string,
  opts: { projectId?: string; taskId?: string; verdict?: ClaimVerdict; limit?: number },
): Promise<ProofClaimRow[]> {
  const conditions: string[] = ['owner_id = $1'];
  const params: unknown[] = [userId];
  if (opts.projectId) {
    params.push(opts.projectId);
    conditions.push(`project_id = $${params.length}`);
  }
  if (opts.taskId) {
    params.push(opts.taskId);
    conditions.push(`task_id = $${params.length}`);
  }
  if (opts.verdict) {
    params.push(opts.verdict);
    conditions.push(`verdict = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 100, 200));
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      `SELECT * FROM proof_claims WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    )).rows,
  );
  return rows.map(rowOf);
}

/** PROOF BADGE (#70): aggregate the trust state of a task's claims. */
export async function taskBadge(userId: string, taskId: string): Promise<{
  taskId: string;
  total: number;
  verified: number;
  partial: number;
  unverified: number;
  verdict: ClaimVerdict;
}> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT verdict, count(*)::int AS n FROM proof_claims WHERE owner_id = $1 AND task_id = $2 GROUP BY verdict',
      [userId, taskId],
    )).rows,
  );
  const counts = { verified: 0, partial: 0, unverified: 0 };
  for (const r of rows) {
    const v = rowOf({ ...r, id: 'x', owner_id: userId, project_id: null, claim: '', why_trace: [], created_at: new Date(), updated_at: new Date() }).verdict;
    if (v === 'VERIFIED') counts.verified += Number(r.n) || 0;
    else if (v === 'PARTIAL') counts.partial += Number(r.n) || 0;
    else counts.unverified += Number(r.n) || 0;
  }
  const total = counts.verified + counts.partial + counts.unverified;
  const verdict: ClaimVerdict =
    total === 0 ? 'UNVERIFIED' : counts.unverified === 0 && counts.partial === 0 && counts.verified > 0 ? 'VERIFIED' : counts.verified > 0 ? 'PARTIAL' : 'UNVERIFIED';
  return { taskId, total, ...counts, verdict };
}

/** WHY-BUTTON (#71): the append-only reasoning trace of a claim. */
export async function whyTrace(userId: string, claimId: string): Promise<{ claim: string; trace: string[]; verdict: ClaimVerdict }> {
  const c = await getClaim(userId, claimId);
  return { claim: c.claim, trace: c.why_trace, verdict: c.verdict };
}