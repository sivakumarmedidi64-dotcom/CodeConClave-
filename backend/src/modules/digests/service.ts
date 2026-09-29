/**
 * CodeConClave — digests (Phase 14).
 * Server-side daily/weekly digest foundation built on REAL persisted evidence
 * (completed/failed/recovered tasks, pending approvals, project + team
 * activity, research, memory/DNA changes, unread notifications, usage).
 * Scheduling is per-user local time (IANA timezone), DND/quiet hours suppress
 * the email channel (never the persisted digest), and the UNIQUE
 * (owner, frequency, period_key) constraint guarantees a period is never
 * delivered twice. AI narrative is strictly evidence-only via the AI Gateway;
 * without a configured provider the summary is deterministic — never faked.
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { createNotification, getNotificationPreferences, inQuietHours, type NotificationPreferences } from '../notifications/service.js';
import { enqueueOutbox } from '../outbox/service.js';
import { configuredProviders } from '../ai/registry.js';
import { completeWithFallback } from '../ai/gateway.js';

export type DigestFrequency = 'daily' | 'weekly';

export interface DigestDeliveryRow {
  id: string;
  owner_id: string;
  frequency: DigestFrequency;
  period_key: string;
  period_start: Date;
  period_end: Date;
  evidence: Record<string, unknown>;
  summary_text: string;
  ai_generated: boolean;
  delivered_at: Date;
  created_at: Date;
}

export interface DigestEvidence {
  completedTasks: { id: string; title: string }[];
  failedTasks: { id: string; title: string; recoveryStatus: string | null }[];
  pendingApprovals: { id: string; riskLevel: string }[];
  counts: {
    completed: number;
    failed: number;
    recovered: number;
    pendingApprovals: number;
    projectActivity: number;
    teamActivity: number;
    research: number;
    memoryUpdates: number;
    dnaUpdates: number;
    unreadNotifications: number;
    messages: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

// ---------------------------------------------------------------- timezone helpers

/** Local calendar date (YYYY-MM-DD) in the user's timezone. */
export function localDateKey(now: Date, timezone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* invalid timezone: fall back to UTC */
  }
  return now.toISOString().slice(0, 10);
}

/** ISO week key (YYYY-Www) for a local date in the user's timezone. */
export function isoWeekKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- preferences

export interface DigestPlan {
  frequency: 'daily' | 'weekly' | 'none';
  timezone: string;
  dnd: boolean;
  quietHours: NotificationPreferences['quiet_hours'] | null;
}

export async function digestPlanFor(userId: string, prefs?: NotificationPreferences, now = new Date()): Promise<DigestPlan> {
  const p = prefs ?? (await getNotificationPreferences(userId));
  const quiet = p.quiet_hours;
  const dnd = Boolean(p.dnd) || inQuietHours(quiet, now);
  const timezone = p.timezone || quiet?.timezone || 'UTC';
  return {
    frequency: p.weekly_digest ? 'weekly' : p.daily_digest ? 'daily' : 'none',
    timezone,
    dnd,
    quietHours: quiet ?? null,
  };
}

export function periodKeyFor(frequency: DigestFrequency, now: Date, timezone: string): string {
  return frequency === 'daily' ? localDateKey(now, timezone) : isoWeekKey(localDateKey(now, timezone));
}

// ---------------------------------------------------------------- evidence

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function collectEvidence(userId: string, since: Date): Promise<DigestEvidence> {
  const sinceIso = since.toISOString();
  const today = new Date().toISOString().slice(0, 10);
  return withTenant(userId, async (q) => {
    const [
      completedRows,
      failedRows,
      approvalRows,
      projectActivity,
      teamActivity,
      research,
      memoryCount,
      dnaCount,
      unreadCount,
      usageRows,
] = await Promise.all([
      await q.query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks
         WHERE owner_id = $1 AND status = 'COMPLETED' AND completed_at > $2 ORDER BY completed_at DESC LIMIT 20`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ id: string; title: string; recovery_status: string | null }>(
        `SELECT id, title, recovery_status FROM tasks
         WHERE owner_id = $1 AND status IN ('FAILED','TIMED_OUT') AND failed_at > $2 ORDER BY failed_at DESC LIMIT 20`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ id: string; risk_level: string }>(
        `SELECT id, risk_level FROM approvals
         WHERE owner_id = $1 AND status = 'PENDING' AND expires_at > now() ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM project_activity pa JOIN projects p ON p.id = pa.project_id
         WHERE p.owner_id = $1 AND pa.created_at > $2`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM team_activity ta JOIN team_members tm ON tm.team_id = ta.team_id
         WHERE tm.user_id = $1 AND tm.status = 'ACTIVE' AND ta.created_at > $2`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM coworker_runs cr JOIN tasks t ON t.id = cr.task_id
         WHERE t.owner_id = $1 AND cr.completed_at > $2`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM memories WHERE owner_id = $1 AND deleted_at IS NULL AND created_at > $2',
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM dna WHERE owner_id = $1 AND deleted_at IS NULL AND created_at > $2',
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications
         WHERE recipient_id = $1 AND deleted_at IS NULL AND read = false AND created_at > $2`,
        [userId, sinceIso],
      ).then((r) => r.rows),
      await q.query<{ input_tokens: number; output_tokens: number; cost: number; calls: number }>(
        `SELECT COALESCE(SUM(input_tokens),0)::int AS input_tokens,
                COALESCE(SUM(output_tokens),0)::int AS output_tokens,
                COALESCE(SUM(estimated_cost_usd),0) AS cost,
                COUNT(*)::int AS calls
         FROM model_usage_logs WHERE user_id = $1 AND created_at > $2`,
        [userId, sinceIso],
      ).then((r) => r.rows),
    ]);
    const usage = usageRows[0] ?? { input_tokens: 0, output_tokens: 0, cost: 0, calls: 0 };
    const messageRows = await q.query<{ n: number }>(
      `SELECT COALESCE(SUM(quantity),0)::int AS n FROM usage_events
       WHERE owner_id = $1 AND name = 'messages' AND bucket = $2`,
      [userId, today],
    ).then((r) => r.rows);

    return {
      completedTasks: completedRows.map((r) => ({ id: r.id, title: r.title })),
      failedTasks: failedRows.map((r) => ({ id: r.id, title: r.title, recoveryStatus: r.recovery_status })),
      pendingApprovals: approvalRows.map((r) => ({ id: r.id, riskLevel: r.risk_level })),
      counts: {
        completed: completedRows.length,
        failed: failedRows.length,
        recovered: failedRows.filter((r) => r.recovery_status && r.recovery_status !== 'none').length,
        pendingApprovals: approvalRows.length,
        projectActivity: projectActivity[0]?.n ?? 0,
        teamActivity: teamActivity[0]?.n ?? 0,
        research: research[0]?.n ?? 0,
        memoryUpdates: memoryCount[0]?.n ?? 0,
        dnaUpdates: dnaCount[0]?.n ?? 0,
        unreadNotifications: unreadCount[0]?.n ?? 0,
        messages: messageRows[0]?.n ?? 0,
        aiCalls: usage.calls,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        estimatedCostUsd: Number(usage.cost ?? 0),
      },
    };
  });
}

export function deterministicDigestText(evidence: DigestEvidence): string {
  const c = evidence.counts;
  const parts: string[] = [];
  if (c.completed > 0) parts.push(`${plural(c.completed, 'task')} completed`);
  if (c.failed > 0) parts.push(`${plural(c.failed, 'task')} failed`);
  if (c.recovered > 0) parts.push(`${plural(c.recovered, 'task')} recovered`);
  if (c.pendingApprovals > 0) parts.push(`${plural(c.pendingApprovals, 'approval')} awaiting review`);
  if (c.projectActivity > 0) parts.push(`${plural(c.projectActivity, 'project activity event')}`);
  if (c.teamActivity > 0) parts.push(`${plural(c.teamActivity, 'team activity event')}`);
  if (c.research > 0) parts.push(`${plural(c.research, 'research finding')}`);
  if (c.memoryUpdates > 0) parts.push(`${plural(c.memoryUpdates, 'memory update')}`);
  if (c.dnaUpdates > 0) parts.push(`${plural(c.dnaUpdates, 'DNA update')}`);
  const headline = parts.length
    ? `Your digest: ${parts.join(', ')}.`
    : 'Your digest: no notable changes.';
  const usageBits: string[] = [];
  if (c.messages > 0) usageBits.push(`${plural(c.messages, 'message')}`);
  if (c.aiCalls > 0) usageBits.push(`${plural(c.aiCalls, 'AI call')} (${c.inputTokens.toLocaleString()} in / ${c.outputTokens.toLocaleString()} out tokens)`);
  if (c.estimatedCostUsd > 0) usageBits.push(`estimated compute $${c.estimatedCostUsd.toFixed(4)}`);
  const usageLine = usageBits.length ? ` Usage: ${usageBits.join(', ')}.` : '';
  return c.unreadNotifications > 0
    ? `${headline}${usageLine} ${plural(c.unreadNotifications, 'unread notification')} waiting.`
    : `${headline}${usageLine}`;
}

/** Optional AI narrative: summarizes ONLY the passed evidence; never invents. */
async function summarizeDigest(userId: string, evidence: DigestEvidence): Promise<{ text: string; aiGenerated: boolean }> {
  const deterministic = deterministicDigestText(evidence);
  if (configuredProviders().length === 0) return { text: deterministic, aiGenerated: false };
  try {
    const planId = await withTenant(userId, async (q) => {
      const planRows = await q.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]);
      return (planRows.rows[0]?.plan_id as 'free' | 'pro' | 'team' | 'enterprise') ?? 'free';
    });
    const ai = await completeWithFallback({
      ctx: { userId, sessionId: '', planId, tenantId: userId },
      messages: [
        {
          role: 'system',
          content:
            'You are CodeConClave. Write a short digest summary using ONLY the evidence provided. Never invent tasks, counts, outcomes, costs or recommendations. If nothing notable happened, say so plainly.',
        },
        { role: 'user', content: JSON.stringify({ counts: evidence.counts, completed: evidence.completedTasks, failed: evidence.failedTasks }) },
      ],
      opts: { computeClass: 'A', excludePremium: true },
      maxTokens: 200,
    });
    if (ai.text && ai.text.trim()) return { text: ai.text.trim(), aiGenerated: true };
    return { text: deterministic, aiGenerated: false };
  } catch {
    return { text: deterministic, aiGenerated: false };
  }
}

// ---------------------------------------------------------------- delivery

export function toDigestJson(row: DigestDeliveryRow) {
  return {
    id: row.id,
    frequency: row.frequency,
    periodKey: row.period_key,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    evidence: row.evidence ?? {},
    summaryText: row.summary_text,
    aiGenerated: row.ai_generated,
    deliveredAt: new Date(row.delivered_at).toISOString(),
  };
}

export async function latestDigest(userId: string): Promise<DigestDeliveryRow | null> {
  const rows = await withTenant<{ rows: DigestDeliveryRow[] }>(userId, async (q) =>
    q.query<DigestDeliveryRow>(
      'SELECT * FROM digest_deliveries WHERE owner_id = $1 ORDER BY delivered_at DESC LIMIT 1',
      [userId],
    ),
  );
  return rows.rows[0] ?? null;
}

export async function lastPeriodKey(userId: string, frequency: DigestFrequency): Promise<string | null> {
  const rows = await withTenant<{ rows: { period_key: string }[] }>(userId, async (q) =>
    q.query<{ period_key: string }>(
      'SELECT period_key FROM digest_deliveries WHERE owner_id = $1 AND frequency = $2 ORDER BY delivered_at DESC LIMIT 1',
      [userId, frequency],
    ),
  );
  return rows.rows[0]?.period_key ?? null;
}

/**
 * Deliver the digest for the current period. Idempotent: once a period has
 * been delivered it is never delivered again (UNIQUE + pre-check). DND/quiet
 * hours suppress the EMAIL channel only — the persisted digest + in-app
 * notification are still produced.
 */
export async function deliverDigest(userId: string, frequency: DigestFrequency, now = new Date()): Promise<DigestDeliveryRow | null> {
  const prefs = await getNotificationPreferences(userId);
  const plan = await digestPlanFor(userId, prefs, now);
  const timezone = plan.timezone;
  const periodKey = periodKeyFor(frequency, now, timezone);
  const existing = await lastPeriodKey(userId, frequency);
  if (existing === periodKey) return null;

  const windowMs = frequency === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - windowMs);
  const evidence = await collectEvidence(userId, periodStart);
  const { text: summaryText, aiGenerated } = await summarizeDigest(userId, evidence);

  const id = newId(PREFIX.DIGEST);
  const result = await withTenant<{ rowCount: number | null }>(userId, async (q) =>
    q.query(
      `INSERT INTO digest_deliveries (id, owner_id, frequency, period_key, period_start, period_end, evidence, summary_text, ai_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (owner_id, frequency, period_key) DO NOTHING`,
      [id, userId, frequency, periodKey, periodStart, now, JSON.stringify(evidence), summaryText, aiGenerated],
    ),
  );
  if ((result.rowCount ?? 0) === 0) return null;

  await createNotification({
    recipientId: userId,
    type: frequency === 'daily' ? NotificationType.DIGEST_DAILY : NotificationType.DIGEST_WEEKLY,
    title: frequency === 'daily' ? 'Daily digest' : 'Weekly digest',
    body: summaryText,
    resourceType: 'digest',
    resourceId: id,
  });

  const quiet = plan.dnd;
  const emailEligible = prefs.email === true && !quiet;
  if (emailEligible) {
    await enqueueOutbox(
      'digest.email',
      {
        channel: 'email',
        userId,
        subject: `CodeConClave ${frequency} digest`,
        html: `<p>${escapeHtml(summaryText)}</p>`,
      },
      { dedupeKey: `digest:${userId}:${frequency}:${periodKey}` },
    );
  }

  await recordAudit({
    action: AuditAction.DIGEST_DELIVERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'digest',
    resourceId: id,
    detail: { frequency, periodKey, aiGenerated, emailEligible },
  });
  const rows = await withTenant<{ rows: DigestDeliveryRow[] }>(userId, async (q) =>
    q.query<DigestDeliveryRow>('SELECT * FROM digest_deliveries WHERE id = $1', [id]),
  );
  return rows.rows[0] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------- sweep

export interface DigestUserPrefRow {
  owner_id: string;
  prefs: NotificationPreferences;
}

/**
 * Watchdog-style sweep: every user with a daily/weekly digest preference is
 * checked against their local period; due periods are delivered (bounded per
 * sweep). Returns the number of digests delivered.
 */
export async function sweepDigests(now = new Date(), limit = 500): Promise<number> {
  const users = await withSystem<{ rows: DigestUserPrefRow[] }>(async (q) =>
    q.query<DigestUserPrefRow>(
      `SELECT owner_id, prefs FROM notification_preferences
       WHERE (prefs->>'daily_digest')::boolean IS TRUE OR (prefs->>'weekly_digest')::boolean IS TRUE
       ORDER BY updated_at LIMIT $1`,
      [limit],
    ),
  );
  let delivered = 0;
  for (const u of users.rows) {
    try {
      const plan = await digestPlanFor(u.owner_id, u.prefs);
      if (plan.frequency === 'none') continue;
      const row = await deliverDigest(u.owner_id, plan.frequency, now);
      if (row) delivered++;
    } catch (err) {
      // One user's failure must never stop the sweep.
      logger.warn('digest user sweep failed', { userId: u.owner_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return delivered;
}