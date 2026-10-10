/**
 * CodeConClave — deterministic period digest (reporting core).
 *
 * Pure computation over REAL task + audit rows supplied by the caller (which
 * queries the database): status counts, completions, failures with their real
 * error codes, and a markdown brief. No database access here (no new tables),
 * no Slack/email delivery here, no scheduling claims — those are explicit
 * integration gaps (see module docs). What this proves: the numbers in a
 * "weekly report" featureset are derived, never invented.
 */
import { AppError } from '../../shared/errors.js';

export interface DigestTaskRow {
  id: string;
  title: string;
  status: string;
  errorCode?: string | null;
  updatedAt: string;
}

export interface DigestAuditRow {
  action: string;
  resourceType: string;
  createdAt: string;
}

export interface DigestInput {
  period: string;
  projectId: string;
  tasks: DigestTaskRow[];
  audits: DigestAuditRow[];
  maxItems?: number;
}

export interface PeriodDigest {
  period: string;
  projectId: string;
  generatedAt: string;
  counts: { total: number; byStatus: Record<string, number>; completed: number; failed: number; cancelled: number };
  failures: Array<{ id: string; title: string; errorCode: string }>;
  topActions: Array<{ action: string; count: number }>;
  markdown: string;
}

const TERMINAL_OK = new Set(['COMPLETED', 'VERIFIED']);
const TERMINAL_FAIL = new Set(['FAILED', 'DEAD_LETTERED', 'TIMED_OUT']);

export function buildPeriodDigest(input: DigestInput): PeriodDigest {
  if (!input.period || !input.projectId) throw AppError.badRequest('invalid_input', 'period and projectId are required');
  if (!Array.isArray(input.tasks) || !Array.isArray(input.audits)) {
    throw AppError.badRequest('invalid_input', 'tasks and audits must be arrays');
  }
  const cap = Math.max(1, Math.min(input.maxItems ?? 50, 200));
  const byStatus: Record<string, number> = {};
  for (const t of input.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const completed = input.tasks.filter((t) => TERMINAL_OK.has(t.status)).length;
  const failedRows = input.tasks.filter((t) => TERMINAL_FAIL.has(t.status)).slice(0, cap);
  const cancelled = input.tasks.filter((t) => t.status === 'CANCELLED').length;
  const failures = failedRows.map((t) => ({ id: t.id, title: t.title, errorCode: t.errorCode ?? 'unspecified' }));

  const actionCounts = new Map<string, number>();
  for (const a of input.audits) actionCounts.set(a.action, (actionCounts.get(a.action) ?? 0) + 1);
  const topActions = [...actionCounts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || (a.action < b.action ? -1 : 1))
    .slice(0, 10);

  const lines = [
    `# Period digest — ${input.period} (project ${input.projectId})`,
    ``,
    `- Tasks seen: ${input.tasks.length} (completed ${completed}, failed ${failedRows.length}, cancelled ${cancelled})`,
    ...failures.map((f) => `- FAILED ${f.id} "${f.title}" [${f.errorCode}]`),
    ...(topActions.length ? [`- Most frequent events: ${topActions.slice(0, 3).map((a) => `${a.action} x${a.count}`).join(', ')}`] : []),
    failures.length === 0 ? `- No failed tasks in this period.` : `- Attention: ${failedRows.length} failure(s) listed above with real error codes.`,
  ];
  return {
    period: input.period,
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    counts: { total: input.tasks.length, byStatus, completed, failed: failedRows.length, cancelled },
    failures,
    topActions,
    markdown: lines.join('\n'),
  };
}
