/**
 * CodeConClave — Superpowers: HIRING ASSISTANT (#146).
 *
 * Interview + take-home auto-evaluated; scores calibrated against existing team.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface HiringAssistantRow {
  id: string;
  owner_id: string;
  candidate_name: string;
  interview_score: number | null;
  take_home_score: number | null;
  calibrated_score: number | null;
  team_average: number | null;
  status: string;
  recommendation: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): HiringAssistantRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  candidate_name: String(r.candidate_name),
  interview_score: r.interview_score == null ? null : Number(r.interview_score),
  take_home_score: r.take_home_score == null ? null : Number(r.take_home_score),
  calibrated_score: r.calibrated_score == null ? null : Number(r.calibrated_score),
  team_average: r.team_average == null ? null : Number(r.team_average),
  status: String(r.status),
  recommendation: r.recommendation == null ? null : String(r.recommendation),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createHiringEvaluation(userId: string, input: { candidate_name: string }): Promise<HiringAssistantRow> {
  if (!input.candidate_name || typeof input.candidate_name !== 'string') throw AppError.badRequest('candidate_name_required', 'candidate name is required');
  const id = newId(PREFIX.HIRING_ASSISTANT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO hiring_assistants (id, owner_id, candidate_name, status) VALUES ($1,$2,$3,$4)',
    [id, userId, input.candidate_name, 'PENDING'],
  ));
  await recordAudit({
    action: AuditAction.HIRING_EVALUATION_SCORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'hiring_assistants',
    resourceId: id,
    detail: { candidate_name: input.candidate_name },
  });
  return getHiringEvaluation(userId, id);
}

export async function scoreHiringEvaluation(userId: string, id: string, input: { interview_score: number; take_home_score: number; team_average: number }): Promise<HiringAssistantRow> {
  if (typeof input.interview_score !== 'number') throw AppError.badRequest('interview_score_required', 'interview score is required');
  if (typeof input.take_home_score !== 'number') throw AppError.badRequest('take_home_score_required', 'take home score is required');
  if (typeof input.team_average !== 'number') throw AppError.badRequest('team_average_required', 'team average is required');
  const evalRow = await getHiringEvaluation(userId, id);
  if (evalRow.status === 'SCORED') throw AppError.badRequest('already_scored', 'hiring evaluation already scored');
  const calibrated = (input.interview_score + input.take_home_score) / 2;
  const recommendation = calibrated >= input.team_average ? 'HIRE' : 'PASS';
  await withTenant(userId, (q) => q.query(
    'UPDATE hiring_assistants SET interview_score = $2, take_home_score = $3, calibrated_score = $4, team_average = $5, recommendation = $6, status = $7, updated_at = now() WHERE id = $1 AND owner_id = $8',
    [id, input.interview_score, input.take_home_score, calibrated, input.team_average, recommendation, 'SCORED', userId],
  ));
  await recordAudit({
    action: AuditAction.HIRING_EVALUATION_SCORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'hiring_assistants',
    resourceId: id,
    detail: { calibrated_score: calibrated, recommendation },
  });
  return getHiringEvaluation(userId, id);
}

export async function getHiringEvaluation(userId: string, id: string): Promise<HiringAssistantRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM hiring_assistants WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('hiring_assistant_not_found', 'no hiring assistant found for that id');
  return rowOf(row);
}

export async function listHiringEvaluations(userId: string): Promise<HiringAssistantRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM hiring_assistants WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function hiringAssistantReport(userId: string): Promise<{ evaluations: number; scored: number; hired: number; pending: number }> {
  const evaluations = await listHiringEvaluations(userId);
  return {
    evaluations: evaluations.length,
    scored: evaluations.filter((e) => e.status === 'SCORED').length,
    hired: evaluations.filter((e) => e.recommendation === 'HIRE').length,
    pending: evaluations.filter((e) => e.status === 'PENDING').length,
  };
}
