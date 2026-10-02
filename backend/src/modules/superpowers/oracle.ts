/**
 * CodeConClave — Superpowers: ORACLE (Master Feature #14).
 *
 * Ranks which parts of a codebase are most likely to break next — before they
 * do. Unlike generic linters that flag "ugly by fixed rules", Oracle scores
 * risk from YOUR project's own history: complexity (from the AST/code-topology
 * brain) x change-churn (git-blame touch count) x past failures (incident /
 * regression links). The score is DETERMINISTIC and documented:
 *
 *   raw = 0.40*complexity + 0.35*churn + 0.25*failureRate   (each 0..1)
 *   band: CRITICAL >= 0.80 | HIGH >= 0.55 | MEDIUM >= 0.30 | LOW otherwise
 *
 * Entries are one-per (owner, target_type, target_path) — re-running a scan
 * on the same target updates it instead of accumulating noise. Everything is
 * owner-scoped, audited and removable.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskTargetType = 'FILE' | 'FUNCTION' | 'MODULE';

export interface RiskInput {
  targetType: RiskTargetType;
  targetPath: string;
  complexityScore: number;
  churnScore: number;
  failureLinks: number;
  reasons?: string[];
  projectId?: string | null;
}

export interface RiskScoreRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target_type: RiskTargetType;
  target_path: string;
  complexity_score: number;
  churn_score: number;
  failure_links: number;
  risk_score: number;
  risk_band: RiskBand;
  reasons: string[];
  created_at: Date;
  updated_at: Date;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pure scoring — the exact formula, unit-tested and reversible. */
export function computeRiskBand(complexity: number, churn: number, failureLinks: number): { score: number; band: RiskBand } {
  const score = round2(0.40 * clamp01(complexity) + 0.35 * clamp01(churn) + 0.25 * clamp01(failureLinks));
  const band: RiskBand = score >= 0.8 ? 'CRITICAL' : score >= 0.55 ? 'HIGH' : score >= 0.3 ? 'MEDIUM' : 'LOW';
  return { score, band };
}

function rowOf(r: Record<string, unknown>): RiskScoreRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    target_type: String(r.target_type) as RiskTargetType,
    target_path: String(r.target_path),
    complexity_score: Number(r.complexity_score),
    churn_score: Number(r.churn_score),
    failure_links: Number(r.failure_links),
    risk_score: Number(r.risk_score),
    risk_band: String(r.risk_band) as RiskBand,
    reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

async function findByIdAndOwner(userId: string, riskId: string): Promise<RiskScoreRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>('SELECT * FROM risk_scores WHERE id = $1 AND owner_id = $2', [riskId, userId])
    ).rows,
  );
  if (!rows[0]) throw AppError.notFound('Risk score');
  return rowOf(rows[0]);
}

export async function upsertRiskScore(userId: string, input: RiskInput): Promise<RiskScoreRow> {
  if (!['FILE', 'FUNCTION', 'MODULE'].includes(input.targetType)) {
    throw AppError.badRequest('invalid_target_type', 'targetType must be FILE, FUNCTION or MODULE');
  }
  const path = (input.targetPath ?? '').trim();
  if (!path) throw AppError.badRequest('target_path_required', 'targetPath is required');
  const { score, band } = computeRiskBand(input.complexityScore, input.churnScore, input.failureLinks);
  const reasons = Array.isArray(input.reasons) ? input.reasons.slice(0, 20) : [];

  const id = newId(PREFIX.RISK_SCORE);
  const existing = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        'SELECT * FROM risk_scores WHERE owner_id = $1 AND target_type = $2 AND target_path = $3',
        [userId, input.targetType, path],
      )
    ).rows,
  );
  const prior = existing[0];
  if (prior) {
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE risk_scores
         SET complexity_score = $1, churn_score = $2, failure_links = $3,
             risk_score = $4, risk_band = $5, reasons = $6::jsonb, updated_at = now()
         WHERE id = $7 AND owner_id = $8`,
        [clamp01(input.complexityScore), clamp01(input.churnScore), Math.max(0, Number(input.failureLinks) || 0),
         score, band, JSON.stringify(reasons), String(prior.id), userId],
      ),
    );
  } else {
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO risk_scores (id, owner_id, project_id, target_type, target_path, complexity_score, churn_score, failure_links, risk_score, risk_band, reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [id, userId, input.projectId ?? null, input.targetType, path,
         clamp01(input.complexityScore), clamp01(input.churnScore), Math.max(0, Number(input.failureLinks) || 0),
         score, band, JSON.stringify(reasons)],
      ),
    );
  }
  await recordAudit({
    action: AuditAction.RISK_SCORE_COMPUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'risk_scores',
    resourceId: existing[0] ? String(existing[0].id) : id,
    detail: { targetPath: path, riskScore: score, band },
  });
  return existing[0] ? findByIdAndOwner(userId, String(existing[0].id)) : findByIdAndOwner(userId, id);
}

export async function listRiskScores(userId: string, opts: { band?: RiskBand } = {}): Promise<RiskScoreRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM risk_scores WHERE owner_id = $1', [userId])).rows,
  );
  return rows
    .map(rowOf)
    .filter((r) => (opts.band ? r.risk_band === opts.band : true))
    .sort((a, b) => b.risk_score - a.risk_score);
}

export async function getRiskScore(userId: string, riskId: string): Promise<RiskScoreRow> {
  return findByIdAndOwner(userId, riskId);
}

export async function removeRiskScore(userId: string, riskId: string): Promise<{ removed: boolean }> {
  await findByIdAndOwner(userId, riskId);
  await withTenant(userId, (q) =>
    q.query('DELETE FROM risk_scores WHERE id = $1 AND owner_id = $2', [riskId, userId]),
  );
  await recordAudit({
    action: AuditAction.RISK_SCORE_REMOVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'risk_scores',
    resourceId: riskId,
    detail: {},
  });
  return { removed: true };
}