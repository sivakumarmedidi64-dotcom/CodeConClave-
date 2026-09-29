/**
 * CodeConClave — return-to-work ("While You Were Away") module (Phase 12).
 *
 * Evidence-based, server-authoritative summaries of what happened while the
 * user was away. Every number and recommendation is derived from persisted
 * rows (tasks, approvals, files, coworker runs, memory, DNA, activity,
 * notifications) — never invented. Summaries persist in
 * `return_to_work_summaries` with read/dismissed state so a refresh never
 * replays the same moment. Optional AI summarization is strictly
 * evidence-only; when no AI provider is available the summary degrades to a
 * deterministic narrative (never faked AI).
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { WorkspaceStateKey } from '@codeconclave/shared';
import { getPreferences, updatePreferences, getWorkspaceState } from '../workspace/service.js';
import { configuredProviders } from '../ai/registry.js';
import { completeWithFallback } from '../ai/gateway.js';

export type ReturnToWorkFrequency = 'daily' | 'weekly' | 'off';

export interface ReturnToWorkConfig {
  frequency: ReturnToWorkFrequency;
  thresholdHours: number;
  /** Project id scope; null = all projects. */
  projectScope: string | null;
}

export const DEFAULT_RETURN_TO_WORK_CONFIG: ReturnToWorkConfig = {
  frequency: 'daily',
  thresholdHours: 6,
  projectScope: null,
};

const CONFIG_PREF_KEY = 'return_to_work';
const FREQUENCY_CAP_MS: Record<'daily' | 'weekly', number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export interface RecommendedAction {
  type: string;
  label: string;
  target: string;
}

export interface ReturnToWorkSummaryJson {
  id: string;
  generatedAt: string;
  absenceStart: string;
  absenceEnd: string;
  projectScope: string | null;
  frequency: string;
  counts: {
    completed: number;
    failed: number;
    pendingApprovals: number;
    modifiedFiles: number;
    discoveries: number;
    memoryUpdates: number;
    dnaUpdates: number;
    projectActivity: number;
    unreadNotifications: number;
  };
  evidence: Record<string, unknown>;
  recommendedActions: RecommendedAction[];
  summaryText: string;
  aiGenerated: boolean;
  read: boolean;
  dismissed: boolean;
}

interface SummaryRow {
  id: string;
  owner_id: string;
  generated_at: Date;
  absence_start: Date;
  absence_end: Date;
  project_id: string | null;
  frequency: string;
  completed_count: number;
  failed_count: number;
  pending_approval_count: number;
  modified_file_count: number;
  discovery_count: number;
  memory_update_count: number;
  dna_update_count: number;
  project_activity_count: number;
  unread_notification_count: number;
  evidence: Record<string, unknown>;
  summary_text: string | null;
  ai_generated: boolean;
  read: boolean;
  dismissed: boolean;
}

// ---------------------------------------------------------------- config

export async function getReturnToWorkConfig(userId: string): Promise<ReturnToWorkConfig> {
  const prefs = await getPreferences(userId);
  const stored = prefs[CONFIG_PREF_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...DEFAULT_RETURN_TO_WORK_CONFIG };
  }
  const s = stored as Record<string, unknown>;
  const frequency: ReturnToWorkFrequency = s.frequency === 'weekly' || s.frequency === 'off' ? s.frequency : 'daily';
  const threshold = Number(s.thresholdHours);
  const thresholdHours = Number.isFinite(threshold) && threshold >= 1 && threshold <= 24 * 7 ? Math.round(threshold) : DEFAULT_RETURN_TO_WORK_CONFIG.thresholdHours;
  const projectScope = typeof s.projectScope === 'string' && s.projectScope ? s.projectScope : null;
  return { frequency, thresholdHours, projectScope };
}

export async function updateReturnToWorkConfig(
  userId: string,
  patch: Partial<Pick<ReturnToWorkConfig, 'frequency' | 'thresholdHours' | 'projectScope'>>,
): Promise<ReturnToWorkConfig> {
  const current = await getReturnToWorkConfig(userId);
  const next: ReturnToWorkConfig = {
    frequency: patch.frequency ?? current.frequency,
    thresholdHours: patch.thresholdHours ?? current.thresholdHours,
    projectScope: patch.projectScope === null ? null : patch.projectScope ?? current.projectScope,
  };
  await updatePreferences(userId, { [CONFIG_PREF_KEY]: next });
  return next;
}

// ---------------------------------------------------------------- persistence

async function latestSummary(userId: string): Promise<SummaryRow | null> {
  const rows = await withTenant<{ rows: SummaryRow[] }>(userId, (q) =>
    q.query<SummaryRow>('SELECT * FROM return_to_work_summaries WHERE owner_id = $1 ORDER BY generated_at DESC LIMIT 1', [userId]),
  );
  return rows.rows[0] ?? null;
}

export function toSummaryJson(row: SummaryRow): ReturnToWorkSummaryJson {
  return {
    id: row.id,
    generatedAt: new Date(row.generated_at).toISOString(),
    absenceStart: new Date(row.absence_start).toISOString(),
    absenceEnd: new Date(row.absence_end).toISOString(),
    projectScope: row.project_id,
    frequency: row.frequency,
    counts: {
      completed: row.completed_count,
      failed: row.failed_count,
      pendingApprovals: row.pending_approval_count,
      modifiedFiles: row.modified_file_count,
      discoveries: row.discovery_count,
      memoryUpdates: row.memory_update_count,
      dnaUpdates: row.dna_update_count,
      projectActivity: row.project_activity_count,
      unreadNotifications: row.unread_notification_count,
    },
    evidence: row.evidence ?? {},
    recommendedActions: (row.evidence?.recommendedActions ?? []) as RecommendedAction[],
    summaryText: row.summary_text ?? '',
    aiGenerated: row.ai_generated,
    read: row.read,
    dismissed: row.dismissed,
  };
}

// ---------------------------------------------------------------- evidence aggregation

interface EvidenceSet {
  completedTasks: { id: string; title: string; projectId: string | null; recovered: boolean }[];
  failedTasks: { id: string; title: string; status: string; recoveryStatus: string | null }[];
  pendingApprovals: { id: string; taskId: string | null; riskLevel: string }[];
  discoveries: { id: string; coworkerType: string; completedAt: string; taskId: string | null }[];
  counts: {
    completed: number;
    failed: number;
    pendingApprovals: number;
    modifiedFiles: number;
    discoveries: number;
    memoryUpdates: number;
    dnaUpdates: number;
    projectActivity: number;
    unreadNotifications: number;
  };
  runningTask: { id: string; title: string } | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function collectEvidence(userId: string, absenceStart: Date, projectScope: string | null): Promise<EvidenceSet> {
  const since = absenceStart.toISOString();
  const scoped = projectScope !== null;
  const scopeClause = scoped ? ' AND project_id = $3' : '';
  const scopeParams = (params: unknown[]) => (scoped ? [...params, projectScope] : params);

  const [completedRows, failedRows, approvalRows, fileCount, discoveryRows, memoryCount, dnaCount, activityCount, unreadCount, runningRows] =
    await withTenant(userId, async (q) => {
      const completedRaw = (await q.query<{ id: string; title: string; project_id: string | null; attempt_count: number }>(
        `SELECT id, title, project_id, attempt_count FROM tasks
         WHERE owner_id = $1 AND status = 'COMPLETED' AND completed_at > $2${scopeClause}
         ORDER BY completed_at DESC LIMIT 20`,
        scopeParams([userId, since]),
      )).rows;
      const failedRaw = (await q.query<{ id: string; title: string; status: string; recovery_status: string | null }>(
        `SELECT id, title, status, recovery_status FROM tasks
         WHERE owner_id = $1 AND status IN ('FAILED','TIMED_OUT') AND failed_at > $2${scopeClause}
         ORDER BY failed_at DESC LIMIT 20`,
        scopeParams([userId, since]),
      )).rows;
      const approvalRaw = (await q.query<{ id: string; task_id: string | null; risk_level: string }>(
        `SELECT a.id, a.task_id, a.risk_level FROM approvals a
         WHERE a.owner_id = $1 AND a.status = 'PENDING' AND a.expires_at > now()
           ${scoped ? "AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id AND t.project_id = $2)" : ''}
         ORDER BY a.created_at DESC LIMIT 20`,
        scoped ? [userId, projectScope] : [userId],
      )).rows;
      const fileRaw = (await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM file_versions fv JOIN files f ON f.id = fv.file_id
         WHERE f.owner_id = $1 AND fv.created_at > $2${scoped ? ' AND f.project_id = $3' : ''}`,
        scopeParams([userId, since]),
      )).rows;
      const discoveryRaw = (await q.query<{ id: string; coworker_type: string; completed_at: Date; task_id: string }>(
        `SELECT cr.id, cr.coworker_type, cr.completed_at, t.id AS task_id FROM coworker_runs cr
         JOIN tasks t ON t.id = cr.task_id
         WHERE t.owner_id = $1 AND cr.completed_at > $2${scopeClause}
         ORDER BY cr.completed_at DESC LIMIT 20`,
        scopeParams([userId, since]),
      )).rows;
      const memoryRaw = (await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM memories WHERE owner_id = $1 AND deleted_at IS NULL AND created_at > $2',
        [userId, since],
      )).rows;
      const dnaRaw = (await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM dna WHERE owner_id = $1 AND deleted_at IS NULL AND created_at > $2',
        [userId, since],
      )).rows;
      const activityRaw = (await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM project_activity pa JOIN projects p ON p.id = pa.project_id
         WHERE p.owner_id = $1 AND pa.created_at > $2${scoped ? ' AND pa.project_id = $3' : ''}`,
        scopeParams([userId, since]),
      )).rows;
      const unreadRaw = (await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications
         WHERE recipient_id = $1 AND deleted_at IS NULL AND read = false AND created_at > $2`,
        [userId, since],
      )).rows;
      const runningRaw = (await q.query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks
         WHERE owner_id = $1 AND status IN ('RUNNING','TESTING','VERIFIED','REQUIRES_REVIEW','WAITING_FOR_LOCAL_AGENT')${scopeClause}
         ORDER BY updated_at DESC LIMIT 1`,
        scopeParams([userId]),
      )).rows;
      return [completedRaw, failedRaw, approvalRaw, fileRaw, discoveryRaw, memoryRaw, dnaRaw, activityRaw, unreadRaw, runningRaw];
    });

  const completedTasks = completedRows.map((r) => ({
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    recovered: r.attempt_count > 1,
  }));
  const failedTasks = failedRows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    recoveryStatus: r.recovery_status,
  }));
  const pendingApprovals = approvalRows.map((r) => ({ id: r.id, taskId: r.task_id, riskLevel: r.risk_level }));
  const discoveries = discoveryRows.map((r) => ({
    id: r.id,
    coworkerType: r.coworker_type,
    completedAt: new Date(r.completed_at).toISOString(),
    taskId: r.task_id,
  }));

  return {
    completedTasks,
    failedTasks,
    pendingApprovals,
    discoveries,
    counts: {
      completed: completedTasks.length,
      failed: failedTasks.length,
      pendingApprovals: pendingApprovals.length,
      modifiedFiles: fileCount[0]?.n ?? 0,
      discoveries: discoveries.length,
      memoryUpdates: memoryCount[0]?.n ?? 0,
      dnaUpdates: dnaCount[0]?.n ?? 0,
      projectActivity: activityCount[0]?.n ?? 0,
      unreadNotifications: unreadCount[0]?.n ?? 0,
    },
    runningTask: runningRows[0] ?? null,
  };
}

function buildActions(evidence: EvidenceSet): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  if (evidence.counts.pendingApprovals > 0) {
    actions.push({ type: 'open_approvals', label: `Review ${plural(evidence.counts.pendingApprovals, 'pending approval')}`, target: '/approvals' });
  }
  if (evidence.failedTasks.length > 0) {
    actions.push({ type: 'review_failures', label: `Review ${plural(evidence.failedTasks.length, 'failed task')}`, target: '/work' });
  }
  if (evidence.completedTasks.length > 0) {
    actions.push({ type: 'review_completed', label: `See ${plural(evidence.completedTasks.length, 'completed task')}`, target: '/work' });
  }
  if (evidence.discoveries.length > 0) {
    actions.push({ type: 'review_research', label: `Review ${plural(evidence.discoveries.length, 'research finding')}`, target: '/ideas' });
  }
  if (evidence.runningTask) {
    actions.push({ type: 'resume_task', label: `Continue "${evidence.runningTask.title.slice(0, 60)}"`, target: '/work' });
  }
  return actions;
}

function deterministicText(evidence: EvidenceSet): string {
  const c = evidence.counts;
  const parts: string[] = [];
  if (c.completed > 0) parts.push(`${plural(c.completed, 'task')} completed`);
  if (c.failed > 0) parts.push(`${plural(c.failed, 'task')} failed`);
  if (c.pendingApprovals > 0) parts.push(`${plural(c.pendingApprovals, 'approval')} awaiting review`);
  if (c.modifiedFiles > 0) parts.push(`${plural(c.modifiedFiles, 'file')} modified`);
  if (c.discoveries > 0) parts.push(`${plural(c.discoveries, 'research finding')}`);
  if (c.memoryUpdates > 0) parts.push(`${plural(c.memoryUpdates, 'memory update')}`);
  if (c.dnaUpdates > 0) parts.push(`${plural(c.dnaUpdates, 'DNA update')}`);
  if (c.projectActivity > 0) parts.push(`${plural(c.projectActivity, 'project activity event')}`);
  const headline = parts.length ? `While you were away: ${parts.join(', ')}.` : 'While you were away: no notable changes.';
  return c.unreadNotifications > 0
    ? `${headline} ${plural(c.unreadNotifications, 'unread notification')} waiting.`
    : headline;
}

/**
 * Optional AI narrative: summarizes ONLY the evidence passed in, with an
 * explicit no-invention instruction. Any failure falls back to the
 * deterministic text with aiGenerated=false.
 */
async function summarizeText(userId: string, evidence: EvidenceSet): Promise<{ text: string; aiGenerated: boolean }> {
  const deterministic = deterministicText(evidence);
  if (configuredProviders().length === 0) return { text: deterministic, aiGenerated: false };
  try {
    const planRows = await withTenant<{ rows: { plan_id: string }[] }>(userId, (q) => q.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]));
    const planId = (planRows.rows[0]?.plan_id as 'free' | 'pro' | 'team' | 'enterprise') ?? 'free';
    const ai = await completeWithFallback({
      ctx: { userId, sessionId: '', planId, tenantId: userId },
      messages: [
        {
          role: 'system',
          content:
            'You are CodeConClave. Write a concise "While You Were Away" summary using ONLY the evidence provided. Never invent tasks, counts, files, outcomes, or recommendations. If nothing notable happened, say so plainly.',
        },
        { role: 'user', content: JSON.stringify({ counts: evidence.counts, actions: buildActions(evidence) }) },
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

// ---------------------------------------------------------------- generation

export async function generateReturnToWorkSummary(
  userId: string,
  config: ReturnToWorkConfig,
  absenceStart: Date,
): Promise<SummaryRow> {
  const evidence = await collectEvidence(userId, absenceStart, config.projectScope);
  const { text: summaryText, aiGenerated } = await summarizeText(userId, evidence);
  const id = newId(PREFIX.RETURN_TO_WORK);
  const absenceEnd = new Date();
  const evidencePayload = {
    completedTasks: evidence.completedTasks,
    failedTasks: evidence.failedTasks,
    pendingApprovals: evidence.pendingApprovals,
    discoveries: evidence.discoveries,
    runningTask: evidence.runningTask,
    recommendedActions: buildActions(evidence),
  };
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO return_to_work_summaries
         (id, owner_id, generated_at, absence_start, absence_end, project_id, frequency,
          completed_count, failed_count, pending_approval_count, modified_file_count,
          discovery_count, memory_update_count, dna_update_count, project_activity_count,
          unread_notification_count, evidence, summary_text, ai_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)`,
      [
        id, userId, absenceEnd, absenceStart, absenceEnd, config.projectScope, config.frequency,
        evidence.counts.completed, evidence.counts.failed, evidence.counts.pendingApprovals,
        evidence.counts.modifiedFiles, evidence.counts.discoveries, evidence.counts.memoryUpdates,
        evidence.counts.dnaUpdates, evidence.counts.projectActivity, evidence.counts.unreadNotifications,
        JSON.stringify(evidencePayload), summaryText, aiGenerated,
      ],
    ),
  );
  const rows = await withTenant<{ rows: SummaryRow[] }>(userId, (q) => q.query<SummaryRow>('SELECT * FROM return_to_work_summaries WHERE id = $1', [id]));
  return rows.rows[0]!;
}

// ---------------------------------------------------------------- read path

export interface ReturnToWorkResponse {
  summary: ReturnToWorkSummaryJson | null;
  eligibility: { eligible: boolean; reason: string };
}

/**
 * Return the current "While You Were Away" moment. Generates a new summary
 * only when the user actually qualifies: absence ≥ threshold and the
 * frequency window has elapsed. `off` never produces a summary.
 */
export async function getReturnToWork(userId: string): Promise<ReturnToWorkResponse> {
  const config = await getReturnToWorkConfig(userId);
  if (config.frequency === 'off') {
    return { summary: null, eligibility: { eligible: false, reason: 'disabled' } };
  }
  const latest = await latestSummary(userId);
  const lastActive = await getWorkspaceState(userId, WorkspaceStateKey.LAST_ACTIVE);
  const lastActiveMs =
    lastActive && typeof lastActive.at === 'string' ? Date.parse(lastActive.at) || 0 : 0;
  const anchorMs = Math.max(lastActiveMs, latest ? new Date(latest.generated_at).getTime() : 0);
  const absenceMs = Date.now() - anchorMs;

  if (absenceMs < config.thresholdHours * 60 * 60 * 1000) {
    return {
      summary: latest && !latest.dismissed ? toSummaryJson(latest) : null,
      eligibility: { eligible: false, reason: 'absence_below_threshold' },
    };
  }
  const capMs = FREQUENCY_CAP_MS[config.frequency];
  if (latest && Date.now() - new Date(latest.generated_at).getTime() < capMs) {
    return {
      summary: latest.dismissed ? null : toSummaryJson(latest),
      eligibility: { eligible: true, reason: 'recent_summary' },
    };
  }
  const row = await generateReturnToWorkSummary(userId, config, new Date(anchorMs));
  return { summary: toSummaryJson(row), eligibility: { eligible: true, reason: 'generated' } };
}

export async function markReturnToWorkRead(userId: string, summaryId: string): Promise<ReturnToWorkSummaryJson> {
  const rows = await withTenant<{ rows: SummaryRow[] }>(userId, (q) =>
    q.query<SummaryRow>(
      `UPDATE return_to_work_summaries SET read = true, read_at = now()
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [summaryId, userId],
    ),
  );
  if (!rows.rows[0]) throw AppError.notFound('Return-to-work summary');
  return toSummaryJson(rows.rows[0]);
}

export async function dismissReturnToWork(userId: string, summaryId: string): Promise<ReturnToWorkSummaryJson> {
  const rows = await withTenant<{ rows: SummaryRow[] }>(userId, (q) =>
    q.query<SummaryRow>(
      `UPDATE return_to_work_summaries SET dismissed = true, dismissed_at = now()
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [summaryId, userId],
    ),
  );
  if (!rows.rows[0]) throw AppError.notFound('Return-to-work summary');
  return toSummaryJson(rows.rows[0]);
}