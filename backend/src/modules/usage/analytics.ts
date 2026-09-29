/**
 * Stage 26G — usage/cost analytics.
 *
 * All numbers are aggregated from the REAL usage ledger (model_usage_logs),
 * file activity (file_activity) and task state. Features are derived from the
 * session/context of each call; unknown sessions land in `general`. The ROI
 * estimate is clearly labeled as an estimate (tasks × a fixed manual
 * equivalent baseline) — never presented as a precise accounting figure.
 */
import { withTenant } from '../../shared/db.js';
import { AuditAction, UsageFeature } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';

export interface FeatureCost {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RoiRow extends FeatureCost {
  tasksCompleted: number;
  valueUsd: number;
  roi: number;
}

export interface TransparencyRow {
  providerId: string;
  modelId: string;
  agent: string | null;
  taskId: string | null;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usedFallback: boolean;
  fallbackReason: string | null;
  outcome: string;
}

export interface HeatmapCell {
  path: string;
  day: string;
  count: number;
  actions: string[];
  intensity: number;
}

const SESSION_FEATURE: Array<[string, string]> = [
  ['chat:', UsageFeature.CHAT],
  ['task:', UsageFeature.TASKS],
  ['pr-review:', UsageFeature.ENGINEERING],
  ['upgrade:', UsageFeature.ENGINEERING],
  ['flake:', UsageFeature.ENGINEERING],
  ['ci:', UsageFeature.ENGINEERING],
  ['goal:', UsageFeature.SCHEDULING],
  ['schedule:', UsageFeature.SCHEDULING],
  ['automation:', UsageFeature.AUTOMATION],
  ['agent:', UsageFeature.AGENTS],
  ['brainstorm:', UsageFeature.BRAINSTORMING],
  ['digest:', UsageFeature.DIGESTS],
  ['preview:', UsageFeature.PREVIEW],
  ['plugin:', UsageFeature.PLUGINS],
];

export function featureForSession(sessionId: string | null | undefined, coworkerType: string | null | undefined): string {
  const s = String(sessionId ?? '').toLowerCase();
  for (const [prefix, feature] of SESSION_FEATURE) {
    if (s.startsWith(prefix)) return feature;
  }
  if (coworkerType && ['ARCHITECT', 'CODER', 'SECURITY', 'TESTER', 'REVIEWER', 'PLANNER', 'DEBUGGER', 'RESEARCHER'].includes(String(coworkerType))) {
    return UsageFeature.TASKS;
  }
  return UsageFeature.GENERAL;
}

interface UsageRow {
  session_id: string | null;
  coworker_type: string | null;
  task_id: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

async function ledgerRows(userId: string, days: number, extraWhere = '', extraParams: unknown[] = []): Promise<UsageRow[]> {
  return withTenant<UsageRow[]>(userId, async (q) =>
    (await q.query<UsageRow>(
      `SELECT session_id, coworker_type, task_id, input_tokens, output_tokens, estimated_cost_usd
       FROM model_usage_logs
       WHERE user_id = $1 AND created_at >= now() - ($2 || ' days')::interval ${extraWhere}`,
      [userId, Math.max(1, Math.min(days, 90)), ...extraParams],
    )).rows,
  );
}

/** Cost per feature over the last N days (from the real ledger). */
export async function costPerFeature(userId: string, days = 30): Promise<FeatureCost[]> {
  const rows = await ledgerRows(userId, days);
  const byFeature = new Map<string, FeatureCost>();
  for (const row of rows) {
    const feature = featureForSession(row.session_id, row.coworker_type);
    const cur = byFeature.get(feature) ?? { feature, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    cur.calls += 1;
    cur.inputTokens += Number(row.input_tokens) || 0;
    cur.outputTokens += Number(row.output_tokens) || 0;
    cur.costUsd += Number(row.estimated_cost_usd) || 0;
    byFeature.set(feature, cur);
  }
  const out = [...byFeature.values()];
  for (const f of out) f.costUsd = Math.round(f.costUsd * 1e6) / 1e6;
  out.sort((a, b) => b.costUsd - a.costUsd);
  return out;
}

/** Cost of a single task (tenant-scoped by owner). */
export async function costPerTask(userId: string, taskId: string): Promise<FeatureCost> {
  const rows = await ledgerRows(userId, 90, 'AND task_id = $3', [taskId]);
  const scoped = rows.filter((r) => r.task_id === taskId);
  const cost: FeatureCost = { feature: 'task', calls: scoped.length, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const row of scoped) {
    cost.inputTokens += Number(row.input_tokens) || 0;
    cost.outputTokens += Number(row.output_tokens) || 0;
    cost.costUsd += Number(row.estimated_cost_usd) || 0;
  }
  cost.costUsd = Math.round(cost.costUsd * 1e6) / 1e6;
  return cost;
}

/** ROI estimate — clearly labeled. valueUsd = tasks completed × $5 baseline. */
export async function roiEstimate(userId: string, days = 30): Promise<{ rows: RoiRow[]; label: string }> {
  const features = await costPerFeature(userId, days);
  const rows = await ledgerRows(userId, days);
  const tasksByFeature = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.task_id) continue;
    const feature = featureForSession(row.session_id, row.coworker_type);
    let set = tasksByFeature.get(feature);
    if (!set) { set = new Set(); tasksByFeature.set(feature, set); }
    set.add(row.task_id);
  }
  const BASELINE_USD_PER_TASK = 5;
  const out: RoiRow[] = features.map((f) => {
    const tasksCompleted = tasksByFeature.get(f.feature)?.size ?? 0;
    const valueUsd = tasksCompleted * BASELINE_USD_PER_TASK;
    return {
      ...f,
      tasksCompleted,
      valueUsd,
      roi: f.costUsd > 0 ? Math.round((valueUsd / f.costUsd) * 100) / 100 : 0,
    };
  });
  return {
    rows: out,
    label: `estimate — value = completed tasks × $${BASELINE_USD_PER_TASK} manual-equivalent baseline; ROI = value / AI cost`,
  };
}

/** Transparency feed: every AI call with provider/model/agent/task/usage/cost/fallback/outcome. */
export async function transparencyLog(userId: string, days = 7, limit = 200): Promise<TransparencyRow[]> {
  const rows = await withTenant<{
    provider_id: string; model_id: string; coworker_type: string | null; task_id: string | null;
    created_at: string; input_tokens: number; output_tokens: number; estimated_cost_usd: number;
    used_fallback: boolean; fallback_reason: string | null; error_code: string | null;
  }[]>(userId, async (q) =>
    (await q.query<{
      provider_id: string; model_id: string; coworker_type: string | null; task_id: string | null;
      created_at: string; input_tokens: number; output_tokens: number; estimated_cost_usd: number;
      used_fallback: boolean; fallback_reason: string | null; error_code: string | null;
    }>(
      `SELECT provider_id, model_id, coworker_type, task_id, created_at, input_tokens, output_tokens,
              estimated_cost_usd, used_fallback, fallback_reason, error_code
       FROM model_usage_logs
       WHERE user_id = $1 AND created_at >= now() - ($2 || ' days')::interval
       ORDER BY created_at DESC LIMIT $3`,
      [userId, Math.max(1, Math.min(days, 90)), Math.min(Math.max(limit, 1), 500)],
    )).rows,
  );
  return rows.map((r) => ({
    providerId: r.provider_id,
    modelId: r.model_id,
    agent: r.coworker_type ?? null,
    taskId: r.task_id ?? null,
    createdAt: r.created_at,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    costUsd: Math.round((Number(r.estimated_cost_usd) || 0) * 1e6) / 1e6,
    usedFallback: Boolean(r.used_fallback),
    fallbackReason: r.fallback_reason ?? null,
    outcome: r.error_code ?? 'ok',
  }));
}

/** Change heatmap: REAL file activity only (file_activity ledger). */
export async function changeHeatmap(userId: string, projectId: string, days = 14): Promise<HeatmapCell[]> {
  const rows = await withTenant<{ path: string; action: string; day: string }[]>(userId, async (q) =>
    (await q.query<{ path: string; action: string; day: string }>(
      `SELECT f.path, fa.action, to_char(fa.created_at, 'YYYY-MM-DD') AS day
       FROM file_activity fa
       JOIN files f ON f.id = fa.file_id
       WHERE fa.project_id = $1 AND fa.actor_user_id = $2 AND fa.created_at >= now() - ($3 || ' days')::interval`,
      [projectId, userId, Math.max(1, Math.min(days, 90))],
    )).rows,
  );
  const byCell = new Map<string, HeatmapCell>();
  for (const r of rows) {
    const key = `${r.path}|${r.day}`;
    const cell = byCell.get(key) ?? { path: r.path, day: r.day, count: 0, actions: [], intensity: 0 };
    cell.count += 1;
    if (!cell.actions.includes(r.action)) cell.actions.push(r.action);
    byCell.set(key, cell);
  }
  const cells = [...byCell.values()];
  const max = Math.max(1, ...cells.map((c) => c.count));
  for (const c of cells) c.intensity = Math.round((c.count / max) * 100) / 100;
  cells.sort((a, b) => (a.day === b.day ? b.count - a.count : a.day.localeCompare(b.day)));
  return cells;
}

/** Refresh the usage_rollups table from the ledger for the last N days. */
export async function refreshUsageRollups(userId: string, days = 7): Promise<number> {
  const features = await costPerFeature(userId, days);
  const rows = await ledgerRows(userId, days);
  const byFeatureTask = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const row of rows) {
    if (!row.task_id) continue;
    const key = `${featureForSession(row.session_id, row.coworker_type)}|${row.task_id}`;
    const cur = byFeatureTask.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    cur.calls += 1;
    cur.inputTokens += Number(row.input_tokens) || 0;
    cur.outputTokens += Number(row.output_tokens) || 0;
    cur.costUsd += Number(row.estimated_cost_usd) || 0;
    byFeatureTask.set(key, cur);
  }
  const bucket = new Date().toISOString().slice(0, 10);
  for (const f of features) {
    await upsertRollup(userId, bucket, f.feature, null, f.calls, f.inputTokens, f.outputTokens, f.costUsd);
  }
  for (const [key, cur] of byFeatureTask) {
    const [feature, taskId] = key.split('|');
    await upsertRollup(userId, bucket, feature!, taskId!, cur.calls, cur.inputTokens, cur.outputTokens, cur.costUsd);
  }
  await recordAudit({
    action: AuditAction.USAGE_ROLLUP_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'usage_rollup',
    resourceId: bucket,
    detail: { bucket, features: features.length, days },
  });
  return features.length;
}

async function upsertRollup(
  userId: string,
  bucket: string,
  feature: string,
  taskId: string | null,
  calls: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): Promise<void> {
  const { newId, PREFIX } = await import('../../shared/ids.js');
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO usage_rollups (id, owner_id, bucket, feature, task_id, calls, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (owner_id, bucket, feature, COALESCE(task_id,'__none__'))
       DO UPDATE SET calls = usage_rollups.calls + EXCLUDED.calls,
                     input_tokens = usage_rollups.input_tokens + EXCLUDED.input_tokens,
                     output_tokens = usage_rollups.output_tokens + EXCLUDED.output_tokens,
                     cost_usd = usage_rollups.cost_usd + EXCLUDED.cost_usd`,
      [newId(PREFIX.USAGE_ROLLUP), userId, bucket, feature, taskId, calls, inputTokens, outputTokens, costUsd],
    ),
  );
}

export async function listUsageRollups(userId: string, days = 7): Promise<Array<Record<string, unknown>>> {
  return withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      `SELECT bucket, feature, COALESCE(task_id,'') AS task_id, calls, input_tokens, output_tokens, cost_usd
       FROM usage_rollups WHERE owner_id = $1 AND bucket >= (now() - ($2 || ' days')::interval)::date
       ORDER BY bucket DESC, cost_usd DESC`,
      [userId, Math.max(1, Math.min(days, 90))],
    )).rows,
  );
}