/**
 * CodeConClave — Cost Analysis (V4D).
 * Extends existing usage/cost system.
 * Tracks: AI cost, task cost, provider cost, feature cost, infrastructure cost.
 * Distinguishes: MEASURED vs ESTIMATED.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';

export type CostCategory =
  | 'AI_INFERENCE'
  | 'AI_EMBEDDING'
  | 'TASK_EXECUTION'
  | 'AGENT_RUN'
  | 'STORAGE'
  | 'COMPUTE'
  | 'NETWORK'
  | 'PROVIDER_API'
  | 'INFRASTRUCTURE'
  | 'UNKNOWN';

export type CostSource = 'MEASURED' | 'ESTIMATED';

export interface CostEntry {
  id: string;
  projectId: string;
  userId?: string;
  category: CostCategory;
  source: CostSource;
  amountUsd: number;
  currency: 'USD';
  quantity: number;
  unit: string;
  description: string;
  metadata: Record<string, unknown>;
  recordedAt: Date;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}

export interface CostBreakdown {
  projectId: string;
  periodStart: Date;
  periodEnd: Date;
  totalUsd: number;
  measuredUsd: number;
  estimatedUsd: number;
  byCategory: Record<CostCategory, { usd: number; measured: number; estimated: number; count: number }>;
  byProvider: Record<string, { usd: number; measured: number; estimated: number; count: number }>;
  byUser: Record<string, { usd: number; measured: number; estimated: number; count: number }>;
  byFeature: Record<string, { usd: number; measured: number; estimated: number; count: number }>;
  trends: CostTrend[];
  topCostDrivers: CostDriver[];
}

export interface CostTrend {
  period: string;
  totalUsd: number;
  measuredUsd: number;
  estimatedUsd: number;
  changePercent: number;
}

export interface CostDriver {
  category: CostCategory;
  provider?: string;
  feature?: string;
  userId?: string;
  usd: number;
  measured: number;
  estimated: number;
  count: number;
  trend: 'INCREASING' | 'DECREASING' | 'STABLE';
}

export interface ProviderCost {
  provider: string;
  model?: string;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  avgCostPerRequest: number;
}

export interface CostAlert {
  id: string;
  projectId: string;
  type: 'BUDGET_EXCEEDED' | 'UNUSUAL_SPIKE' | 'PROVIDER_LIMIT' | 'BUDGET_WARNING';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  currentValue: number;
  threshold: number;
  period: string;
  detectedAt: Date;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
}

export interface Budget {
  id: string;
  projectId: string;
  name: string;
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  limitUsd: number;
  alertThresholdPercent: number;
  categories: CostCategory[];
  createdAt: Date;
  updatedAt: Date;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]),
  );
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function recordCost(
  userId: string,
  projectId: string,
  input: {
    category: CostCategory;
    source: CostSource;
    amountUsd: number;
    quantity: number;
    unit: string;
    description: string;
    metadata?: Record<string, unknown>;
    userId?: string;
    provider?: string;
    model?: string;
    feature?: string;
  }
): Promise<CostEntry> {
  await assertProjectAccess(userId, projectId);

  const now = new Date();
  const billingPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const billingPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const entry: CostEntry = {
    id: newId(PREFIX.COST_ENTRY),
    projectId,
    userId: input.userId ?? userId,
    category: input.category,
    source: input.source,
    amountUsd: input.amountUsd,
    currency: 'USD',
    quantity: input.quantity,
    unit: input.unit,
    description: input.description,
    metadata: {
      ...input.metadata,
      provider: input.provider,
      model: input.model,
      feature: input.feature,
    },
    recordedAt: now,
    billingPeriodStart,
    billingPeriodEnd,
  };

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO cost_entries
         (id, project_id, user_id, category, source, amount_usd, currency, quantity, unit, description, metadata, recorded_at, billing_period_start, billing_period_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        entry.id,
        entry.projectId,
        entry.userId,
        entry.category,
        entry.source,
        entry.amountUsd,
        entry.currency,
        entry.quantity,
        entry.unit,
        entry.description,
        JSON.stringify(entry.metadata),
        entry.recordedAt,
        entry.billingPeriodStart,
        entry.billingPeriodEnd,
      ],
    ),
  );

  await recordAudit({
    action: 'cost_recorded',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cost_entry',
    resourceId: entry.id,
    detail: { category: entry.category, amountUsd: entry.amountUsd, source: entry.source },
  });

  // Check budget alerts
  await checkBudgetAlerts(userId, projectId);

  return entry;
}

export async function recordAICost(
  userId: string,
  projectId: string,
  input: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    source: CostSource;
    feature?: string;
    taskId?: string;
    agentRunId?: string;
  }
): Promise<CostEntry> {
  const category = input.source === 'MEASURED' ? 'AI_INFERENCE' : 'AI_INFERENCE';

  return recordCost(userId, projectId, {
    category,
    source: input.source,
    amountUsd: input.costUsd,
    quantity: input.inputTokens + input.outputTokens,
    unit: 'tokens',
    description: `AI inference: ${input.provider}/${input.model}`,
    metadata: {
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
    },
    feature: input.feature,
  });
}

export async function recordTaskCost(
  userId: string,
  projectId: string,
  input: {
    taskId: string;
    costUsd: number;
    source: CostSource;
    description: string;
    metadata?: Record<string, unknown>;
  }
): Promise<CostEntry> {
  return recordCost(userId, projectId, {
    category: 'TASK_EXECUTION',
    source: input.source,
    amountUsd: input.costUsd,
    quantity: 1,
    unit: 'task',
    description: input.description,
    metadata: { taskId: input.taskId, ...input.metadata },
  });
}

export async function getCostBreakdown(
  userId: string,
  projectId: string,
  options: { periodStart?: Date; periodEnd?: Date; category?: CostCategory } = {}
): Promise<CostBreakdown> {
  await assertProjectAccess(userId, projectId);

  const periodStart = options.periodStart ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const periodEnd = options.periodEnd ?? new Date();

  const conditions: string[] = ['project_id = $1', 'recorded_at >= $2', 'recorded_at <= $3'];
  const params: unknown[] = [projectId, periodStart.toISOString(), periodEnd.toISOString()];
  let paramIndex = 4;

  if (options.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(options.category);
  }

  const whereClause = conditions.join(' AND ');

  const [
    totalResult,
    byCategoryResult,
    byProviderResult,
    byUserResult,
    byFeatureResult,
    trendResult,
  ] = await withTenant(userId, (q) =>
    Promise.all([
      q.query(
        `SELECT sum(amount_usd)::numeric as total,
                sum(amount_usd) FILTER (WHERE source = 'MEASURED')::numeric as measured,
                sum(amount_usd) FILTER (WHERE source = 'ESTIMATED')::numeric as estimated
         FROM cost_entries
         WHERE ${whereClause}`,
        params,
      ),
      q.query(
        `SELECT category, sum(amount_usd)::numeric as usd,
                sum(amount_usd) FILTER (WHERE source = 'MEASURED')::numeric as measured,
                sum(amount_usd) FILTER (WHERE source = 'ESTIMATED')::numeric as estimated,
                count(*)::int as count
         FROM cost_entries
         WHERE ${whereClause}
         GROUP BY category`,
        params,
      ),
      q.query(
        `SELECT metadata->>'provider' as provider, sum(amount_usd)::numeric as usd,
                sum(amount_usd) FILTER (WHERE source = 'MEASURED')::numeric as measured,
                sum(amount_usd) FILTER (WHERE source = 'ESTIMATED')::numeric as estimated,
                count(*)::int as count
         FROM cost_entries
         WHERE ${whereClause} AND metadata ? 'provider'
         GROUP BY metadata->>'provider'`,
        params,
      ),
      q.query(
        `SELECT user_id, sum(amount_usd)::numeric as usd,
                sum(amount_usd) FILTER (WHERE source = 'MEASURED')::numeric as measured,
                sum(amount_usd) FILTER (WHERE source = 'ESTIMATED')::numeric as estimated,
                count(*)::int as count
         FROM cost_entries
         WHERE ${whereClause}
         GROUP BY user_id`,
        params,
      ),
      q.query(
        `SELECT metadata->>'feature' as feature, sum(amount_usd)::numeric as usd,
                sum(amount_usd) FILTER (WHERE source = 'MEASURED')::numeric as measured,
                sum(amount_usd) FILTER (WHERE source = 'ESTIMATED')::numeric as estimated,
                count(*)::int as count
         FROM cost_entries
         WHERE ${whereClause} AND metadata ? 'feature'
         GROUP BY metadata->>'feature'`,
        params,
      ),
      q.query(
        `SELECT date_trunc('day', recorded_at)::date as period, sum(amount_usd)::numeric as total_usd
         FROM cost_entries
         WHERE ${whereClause}
         GROUP BY period
         ORDER BY period ASC`,
        params,
      ),
    ]),
  );

  const total = totalResult.rows[0]?.total ?? 0;
  const measured = totalResult.rows[0]?.measured ?? 0;
  const estimated = totalResult.rows[0]?.estimated ?? 0;

  const byCategory = {} as CostBreakdown['byCategory'];
  for (const row of byCategoryResult.rows) {
    byCategory[row.category as CostCategory] = {
      usd: parseFloat(row.usd),
      measured: parseFloat(row.measured),
      estimated: parseFloat(row.estimated),
      count: row.count,
    };
  }

  const byProvider: CostBreakdown['byProvider'] = {} as any;
  for (const row of byProviderResult.rows) {
    byProvider[row.provider] = {
      usd: parseFloat(row.usd),
      measured: parseFloat(row.measured),
      estimated: parseFloat(row.estimated),
      count: row.count,
    };
  }

  const byUser: CostBreakdown['byUser'] = {} as any;
  for (const row of byUserResult.rows) {
    byUser[row.user_id] = {
      usd: parseFloat(row.usd),
      measured: parseFloat(row.measured),
      estimated: parseFloat(row.estimated),
      count: row.count,
    };
  }

  const byFeature: CostBreakdown['byFeature'] = {} as any;
  for (const row of byFeatureResult.rows) {
    byFeature[row.feature] = {
      usd: parseFloat(row.usd),
      measured: parseFloat(row.measured),
      estimated: parseFloat(row.estimated),
      count: row.count,
    };
  }

  const trends: CostTrend[] = (trendResult.rows || []).map(row => ({
    period: row.period instanceof Date ? row.period.toISOString().split('T')[0] : String(row.period ?? ''),
    totalUsd: parseFloat(row.total_usd || '0'),
    measuredUsd: 0,
    estimatedUsd: 0,
    changePercent: 0,
  }));

  const topCostDrivers: CostDriver[] = Object.entries(byCategory)
    .map(([category, data]) => ({
      category: category as CostCategory,
      usd: data.usd,
      measured: data.measured,
      estimated: data.estimated,
      count: data.count,
      trend: 'STABLE' as const,
    }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 10);

  return {
    projectId,
    periodStart,
    periodEnd,
    totalUsd: parseFloat(total),
    measuredUsd: parseFloat(measured),
    estimatedUsd: parseFloat(estimated),
    byCategory,
    byProvider,
    byUser,
    byFeature,
    trends,
    topCostDrivers,
  };
}

export async function getProviderCosts(
  userId: string,
  projectId: string,
  options: { periodStart?: Date; periodEnd?: Date } = {}
): Promise<ProviderCost[]> {
  await assertProjectAccess(userId, projectId);

  const periodStart = options.periodStart ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const periodEnd = options.periodEnd ?? new Date();

  const rows = await withTenant<{
    provider: string;
    model: string;
    amount_usd: string;
    input_tokens: string;
    output_tokens: string;
    request_count: number;
  }[]>(userId, async (q) =>
    (
      await q.query<{
        provider: string;
        model: string;
        amount_usd: string;
        input_tokens: string;
        output_tokens: string;
        request_count: number;
      }>(
        `SELECT metadata->>'provider' as provider, metadata->>'model' as model,
                sum(amount_usd)::numeric as amount_usd,
                sum((metadata->>'inputTokens')::int) as input_tokens,
                sum((metadata->>'outputTokens')::int) as output_tokens,
                count(*)::int as request_count
         FROM cost_entries
         WHERE project_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
           AND category = 'AI_INFERENCE' AND metadata ? 'provider'
         GROUP BY metadata->>'provider', metadata->>'model'
         ORDER BY sum(amount_usd) DESC`,
        [projectId, periodStart.toISOString(), periodEnd.toISOString()],
      )
    ).rows,
  );

  return rows.map(row => ({
    provider: row.provider,
    model: row.model || undefined,
    totalUsd: parseFloat(row.amount_usd),
    inputTokens: parseInt(row.input_tokens || '0'),
    outputTokens: parseInt(row.output_tokens || '0'),
    requestCount: row.request_count,
    avgCostPerRequest: row.request_count > 0 ? parseFloat(row.amount_usd) / row.request_count : 0,
  }));
}

export async function getCostTrends(
  userId: string,
  projectId: string,
  options: { periodStart?: Date; periodEnd?: Date; granularity?: 'DAY' | 'WEEK' | 'MONTH' } = {}
): Promise<CostTrend[]> {
  await assertProjectAccess(userId, projectId);

  const periodStart = options.periodStart ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const periodEnd = options.periodEnd ?? new Date();
  const granularity = options.granularity ?? 'DAY';

  const rows = await withTenant(userId, (q) =>
    q.query(
      `SELECT date_trunc($1, recorded_at)::date as period, sum(amount_usd)::numeric as total_usd
       FROM cost_entries
       WHERE project_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
       GROUP BY period
       ORDER BY period ASC`,
      [granularity, projectId, periodStart.toISOString(), periodEnd.toISOString()],
    ),
  );

  const trends: CostTrend[] = [];
  for (let i = 0; i < rows.rows.length; i++) {
    const current = parseFloat(rows.rows[i].total_usd);
    const previous = i > 0 ? parseFloat(rows.rows[i - 1].total_usd) : 0;
    const changePercent = previous > 0 ? ((current - previous) / previous) * 100 : 0;

    trends.push({
      period: rows.rows[i].period.toISOString().split('T')[0],
      totalUsd: current,
      measuredUsd: 0,
      estimatedUsd: 0,
      changePercent: Math.round(changePercent * 100) / 100,
    });
  }

  return trends;
}

export async function getTopCostDrivers(
  userId: string,
  projectId: string,
  options: { periodStart?: Date; periodEnd?: Date; limit?: number } = {}
): Promise<CostDriver[]> {
  const breakdown = await getCostBreakdown(userId, projectId, {
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
  });

  return breakdown.topCostDrivers.slice(0, options.limit ?? 10);
}

export async function createBudget(
  userId: string,
  projectId: string,
  input: {
    name: string;
    period: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
    limitUsd: number;
    alertThresholdPercent: number;
    categories?: CostCategory[];
  }
): Promise<Budget> {
  await assertProjectAccess(userId, projectId);

  const budgetId = newId(PREFIX.BUDGET);
  const now = new Date();

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO budgets (id, project_id, name, period, limit_usd, alert_threshold_percent, categories, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        budgetId,
        projectId,
        input.name,
        input.period,
        input.limitUsd,
        input.alertThresholdPercent,
        JSON.stringify(input.categories ?? []),
        now,
        now,
      ],
    ),
  );

  await recordAudit({
    action: 'budget_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'budget',
    resourceId: budgetId,
    detail: { name: input.name, period: input.period, limitUsd: input.limitUsd },
  });

  return {
    id: budgetId,
    projectId,
    name: input.name,
    period: input.period,
    limitUsd: input.limitUsd,
    alertThresholdPercent: input.alertThresholdPercent,
    categories: input.categories ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function getBudgets(
  userId: string,
  projectId: string
): Promise<Budget[]> {
  await assertProjectAccess(userId, projectId);

  const rows = await withTenant<{
    id: string;
    project_id: string;
    name: string;
    period: string;
    limit_usd: number;
    alert_threshold_percent: number;
    categories: string[];
    created_at: Date;
    updated_at: Date;
  }[]>(userId, async (q) =>
    (await q.query('SELECT * FROM budgets WHERE project_id = $1 ORDER BY created_at DESC', [projectId])).rows,
  );

  return rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    period: row.period as Budget['period'],
    limitUsd: row.limit_usd,
    alertThresholdPercent: row.alert_threshold_percent,
    categories: row.categories as CostCategory[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function updateBudget(
  userId: string,
  projectId: string,
  budgetId: string,
  updates: Partial<Pick<Budget, 'name' | 'limitUsd' | 'alertThresholdPercent' | 'categories'>>
): Promise<Budget> {
  await assertProjectAccess(userId, projectId);

  const fields: string[] = [];
  const params: unknown[] = [budgetId];
  let paramIndex = 2;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${snakeKey} = $${paramIndex++}`);
    params.push(value);
  }

  if (fields.length === 0) {
    const budgets = await getBudgets(userId, projectId);
    return budgets.find(b => b.id === budgetId)!;
  }

  fields.push('updated_at = now()');
  params.push(projectId);

  await withTenant(userId, (q) =>
    q.query(`UPDATE budgets SET ${fields.join(', ')} WHERE id = $1 AND project_id = $${params.length}`, params),
  );

  return (await getBudgets(userId, projectId)).find(b => b.id === budgetId)!;
}

export async function checkBudgetAlerts(userId: string, projectId: string): Promise<CostAlert[]> {
  await assertProjectAccess(userId, projectId);

  const budgets = await getBudgets(userId, projectId);
  const alerts: CostAlert[] = [];

  for (const budget of budgets) {
    const breakdown = await getCostBreakdown(userId, projectId, {
      periodStart: getPeriodStart(budget.period),
      periodEnd: new Date(),
    });

    const currentSpend = breakdown.totalUsd;
    const threshold = budget.limitUsd * (budget.alertThresholdPercent / 100);

    if (currentSpend >= budget.limitUsd) {
      alerts.push({
        id: newId(PREFIX.COST_ALERT),
        projectId,
        type: 'BUDGET_EXCEEDED',
        severity: 'CRITICAL',
        message: `Budget "${budget.name}" exceeded: $${currentSpend.toFixed(2)} / $${budget.limitUsd.toFixed(2)}`,
        currentValue: currentSpend,
        threshold: budget.limitUsd,
        period: budget.period,
        detectedAt: new Date(),
        acknowledged: false,
      });
    } else if (currentSpend >= threshold) {
      alerts.push({
        id: newId(PREFIX.COST_ALERT),
        projectId,
        type: 'BUDGET_WARNING',
        severity: 'HIGH',
        message: `Budget "${budget.name}" at ${((currentSpend / budget.limitUsd) * 100).toFixed(1)}%: $${currentSpend.toFixed(2)} / $${budget.limitUsd.toFixed(2)}`,
        currentValue: currentSpend,
        threshold,
        period: budget.period,
        detectedAt: new Date(),
        acknowledged: false,
      });
    }
  }

  // Store alerts
  for (const alert of alerts) {
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO cost_alerts (id, project_id, type, severity, message, current_value, threshold, period, detected_at, acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [alert.id, alert.projectId, alert.type, alert.severity, alert.message, alert.currentValue, alert.threshold, alert.period, alert.detectedAt, alert.acknowledged],
      ),
    );
  }

  return alerts;
}

export async function acknowledgeBudgetAlert(
  userId: string,
  projectId: string,
  alertId: string
): Promise<void> {
  await assertProjectAccess(userId, projectId);

  await withTenant(userId, (q) =>
    q.query(
      `UPDATE cost_alerts SET acknowledged = true, acknowledged_at = now(), acknowledged_by = $1 WHERE id = $2 AND project_id = $3`,
      [userId, alertId, projectId],
    ),
  );

  await recordAudit({
    action: 'cost_budget_alert_acknowledged',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cost_alert',
    resourceId: alertId,
    detail: { alertId, projectId },
  });
}

export async function getCostAlerts(
  userId: string,
  projectId: string,
  options: { acknowledged?: boolean; severity?: string; limit?: number } = {}
): Promise<CostAlert[]> {
  await assertProjectAccess(userId, projectId);

  const conditions: string[] = ['project_id = $1'];
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.acknowledged !== undefined) {
    params.push(options.acknowledged);
    conditions.push(`acknowledged = $${paramIndex++}`);
  }
  if (options.severity) {
    params.push(options.severity);
    conditions.push(`severity = $${paramIndex++}`);
  }

  params.push(options.limit ?? 50);
  const query = `SELECT * FROM cost_alerts WHERE ${conditions.join(' AND ')} ORDER BY detected_at DESC LIMIT $${paramIndex}`;
  params.push(options.limit ?? 50);

  return withTenant<CostAlert[]>(userId, async (q) => (await q.query<CostAlert>(query, params)).rows);
}

function getPeriodStart(period: Budget['period']): Date {
  const now = new Date();
  switch (period) {
    case 'DAILY':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'WEEKLY': {
      const day = now.getDay();
      const diff = now.getDate() - day;
      return new Date(now.setDate(diff));
    }
    case 'MONTHLY':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'QUARTERLY': {
      const quarter = Math.floor(now.getMonth() / 3);
      return new Date(now.getFullYear(), quarter * 3, 1);
    }
    case 'YEARLY':
      return new Date(now.getFullYear(), 0, 1);
  }
}