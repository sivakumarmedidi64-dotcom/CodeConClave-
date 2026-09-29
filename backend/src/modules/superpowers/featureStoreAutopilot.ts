/**
 * CodeConClave — Superpowers: FEATURE-STORE AUTOPILOT (#127).
 *
 * For ML teams: detects feature drift, trains/validates models on new data,
 * drafts retraining PRs. Model deltas included in PR.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FeatureStoreRow {
  id: string;
  owner_id: string;
  model_name: string;
  feature_set: string[];
  drift_score: number | null;
  last_trained_at: Date | null;
  retrain_pr_url: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FeatureStoreRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  model_name: String(r.model_name),
  feature_set: Array.isArray(r.feature_set) ? (r.feature_set as string[]) : [],
  drift_score: r.drift_score == null ? null : Number(r.drift_score),
  last_trained_at: r.last_trained_at ? new Date(r.last_trained_at as string) : null,
  retrain_pr_url: r.retrain_pr_url == null ? null : String(r.retrain_pr_url),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createFeatureStore(userId: string, input: { model_name: string; feature_set: string[] }): Promise<FeatureStoreRow> {
  if (!input.model_name || typeof input.model_name !== 'string') throw AppError.badRequest('invalid_model_name', 'a model name is required');
  if (!Array.isArray(input.feature_set) || input.feature_set.length === 0) throw AppError.badRequest('no_features', 'at least one feature is required');
  const id = newId(PREFIX.FEATURE_STORE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO feature_store_runs (id, owner_id, model_name, feature_set, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.model_name, input.feature_set, 'MONITORING'],
  ));
  await recordAudit({
    action: AuditAction.FEATURE_DRIFT_DETECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'feature_store_runs',
    resourceId: id,
    detail: { model_name: input.model_name, feature_set: input.feature_set },
  });
  return getFeatureStore(userId, id);
}

export async function draftRetrain(userId: string, id: string, input: { drift_score: number; retrain_pr_url: string }): Promise<FeatureStoreRow> {
  if (input.drift_score == null || typeof input.drift_score !== 'number') throw AppError.badRequest('invalid_drift_score', 'a numeric drift score is required');
  if (!input.retrain_pr_url || typeof input.retrain_pr_url !== 'string') throw AppError.badRequest('invalid_retrain_pr_url', 'a retrain PR url is required');
  const store = await getFeatureStore(userId, id);
  if (store.status === 'RETRAINED') throw AppError.badRequest('already_retrained', 'model has already been retrained');
  await withTenant(userId, (q) => q.query(
    'UPDATE feature_store_runs SET drift_score = $2, retrain_pr_url = $3, last_trained_at = now(), status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.drift_score, input.retrain_pr_url, 'RETRAINED', userId],
  ));
  await recordAudit({
    action: AuditAction.MODEL_RETRAIN_DRAFTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'feature_store_runs',
    resourceId: id,
    detail: { drift_score: input.drift_score, retrain_pr_url: input.retrain_pr_url },
  });
  return getFeatureStore(userId, id);
}

export async function getFeatureStore(userId: string, id: string): Promise<FeatureStoreRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM feature_store_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('feature_store_run_not_found', 'no feature store run found for that id');
  return rowOf(row);
}

export async function listFeatureStores(userId: string): Promise<FeatureStoreRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM feature_store_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function featureStoreReport(userId: string): Promise<{ total: number; monitoring: number; retrained: number; avg_drift_score: number }> {
  const runs = await listFeatureStores(userId);
  const withDrift = runs.filter((r) => r.drift_score != null);
  return {
    total: runs.length,
    monitoring: runs.filter((r) => r.status === 'MONITORING').length,
    retrained: runs.filter((r) => r.status === 'RETRAINED').length,
    avg_drift_score: withDrift.length > 0 ? withDrift.reduce((s, r) => s + (r.drift_score ?? 0), 0) / withDrift.length : 0,
  };
}
