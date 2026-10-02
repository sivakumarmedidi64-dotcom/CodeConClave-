/**
 * CodeConClave — Superpowers: CODEBASE NUTRITION LABEL (Feature #158).
 *
 * Every repo gets a public/internal health label: freshness, risk, debt,
 * coverage, security, velocity.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface NutritionLabelRow {
  id: string;
  owner_id: string;
  repo_name: string;
  freshness: number;
  risk: number;
  debt: number;
  coverage: number;
  security: number;
  velocity: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): NutritionLabelRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  repo_name: String(r.repo_name),
  freshness: Number(r.freshness),
  risk: Number(r.risk),
  debt: Number(r.debt),
  coverage: Number(r.coverage),
  security: Number(r.security),
  velocity: Number(r.velocity),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function generateNutritionLabel(userId: string, input: { repo_name: string; freshness: number; risk: number; debt: number; coverage: number; security: number; velocity: number }): Promise<NutritionLabelRow> {
  if (!input.repo_name || typeof input.repo_name !== 'string') throw AppError.badRequest('invalid_repo_name', 'repo name is required');
  const id = newId(PREFIX.NUTRITION_LABEL);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO nutrition_labels (id, owner_id, repo_name, freshness, risk, debt, coverage, security, velocity, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.repo_name, input.freshness, input.risk, input.debt, input.coverage, input.security, input.velocity, 'GENERATED'],
  ));
  await recordAudit({
    action: AuditAction.NUTRITION_LABEL_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'nutrition_labels',
    resourceId: id,
    detail: { repo_name: input.repo_name },
  });
  return getNutritionLabel(userId, id);
}

export async function getNutritionLabel(userId: string, id: string): Promise<NutritionLabelRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM nutrition_labels WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('nutrition_label_not_found', 'no nutrition label found for that id');
  return rowOf(row);
}

export async function listNutritionLabels(userId: string): Promise<NutritionLabelRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM nutrition_labels WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function nutritionLabelReport(userId: string): Promise<{ labels: number; generated: number }> {
  const labels = await listNutritionLabels(userId);
  return {
    labels: labels.length,
    generated: labels.filter((l) => l.status === 'GENERATED').length,
  };
}
