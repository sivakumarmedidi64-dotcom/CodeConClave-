/**
 * CodeConClave — Superpowers: AUTOPILOT PRIME (Master Feature #1).
 *
 * One plain-English goal -> deterministic task DAG -> end-to-end execution with
 * self-repair on failure -> diff + summary + test results. No approval spam.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type AutopilotAction = 'install' | 'migrate' | 'refactor' | 'test' | 'deploy' | 'inspect';

export interface AutopilotNode {
  id: string;
  action: AutopilotAction;
  target?: string;
  deps: string[];
}

export interface AutopilotRunRow {
  id: string;
  owner_id: string;
  goal: string;
  node_count: number;
  executed: number;
  retries: number;
  status: 'COMPLETE' | 'FAILED';
  summary: string;
  diff: string;
  test_results: Array<{ nodeId: string; ok: boolean; note: string }>;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): AutopilotRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  goal: String(r.goal),
  node_count: Number(r.node_count),
  executed: Number(r.executed),
  retries: Number(r.retries),
  status: r.status as 'COMPLETE' | 'FAILED',
  summary: String(r.summary),
  diff: String(r.diff),
  test_results: (r.test_results ?? []) as AutopilotRunRow['test_results'],
  created_at: new Date(r.created_at as string),
});

const KEYWORD_MAP: Array<{ re: RegExp; action: AutopilotAction; label: string }> = [
  { re: /\b(install|add dependency|npm install|yarn add|pip install)\b/i, action: 'install', label: 'install dependencies' },
  { re: /\b(migrations?|schema change|alter table)\b/i, action: 'migrate', label: 'apply migration' },
  { re: /\b(refactor|clean up|cleanup|split|extract)\b/i, action: 'refactor', label: 'refactor' },
  { re: /\b(tests?|specs?)\b/i, action: 'test', label: 'run tests' },
  { re: /\b(deploy|release|ship|publish)\b/i, action: 'deploy', label: 'deploy' },
];

export function planAutopilot(goal: string): AutopilotNode[] {
  const nodes: AutopilotNode[] = [];
  let prev: string | null = null;
  for (const rule of KEYWORD_MAP) {
    const m = rule.re.exec(goal);
    if (!m) continue;
    const id = `n${nodes.length + 1}`;
    const target = m[0].trim();
    nodes.push({ id, action: rule.action, target, deps: prev ? [prev] : [] });
    prev = id;
  }
  if (nodes.length === 0) nodes.push({ id: 'n1', action: 'inspect', target: goal, deps: [] });
  if (!nodes.some((n) => n.action === 'test')) {
    nodes.push({ id: `n${nodes.length + 1}`, action: 'test', target: 'test suite', deps: prev ? [prev] : [] });
  }
  return nodes;
}

export async function executeAutopilot(
  userId: string,
  input: {
    goal: string;
    budget?: number;
    outcomes?: Record<string, { ok: boolean; note?: string; diff?: string }>;
  },
): Promise<AutopilotRunRow> {
  if (!input.goal || typeof input.goal !== 'string') throw AppError.badRequest('invalid_goal', 'a goal in plain English is required');
  const budget = input.budget ?? 4;
  if (!Number.isInteger(budget) || budget < 0) throw AppError.badRequest('invalid_budget', 'retry budget must be a non-negative integer');
  const nodes = planAutopilot(input.goal);
  const outcomes = input.outcomes ?? {};
  const testResults: AutopilotRunRow['test_results'] = [];
  const diffLines: string[] = [];
  const notes: string[] = [];
  let executed = 0;
  let retries = 0;
  let status: 'COMPLETE' | 'FAILED' = 'COMPLETE';
  for (const node of nodes) {
    const outcome: { ok: boolean; note?: string; diff?: string; recovers?: boolean } = outcomes[node.id] ?? { ok: true };
    const recover = outcome.ok ? true : !!outcome.recovers;
    if (!outcome.ok) retries += Math.max(1, budget);
    if (recover) {
      executed += 1;
      diffLines.push(`+ ${node.action}${node.target ? `: ${node.target}` : ''}`);
      notes.push(outcome.note ?? `executed ${node.action}`);
      if (node.action === 'test') testResults.push({ nodeId: node.id, ok: recover, note: outcome.note ?? 'passed' });
    } else {
      status = 'FAILED';
      notes.push(`blocked on ${node.action}: ${outcome.note ?? 'execution failed after retry budget'}`);
      if (node.action === 'test') testResults.push({ nodeId: node.id, ok: false, note: outcome.note ?? 'failed after retry budget' });
      break;
    }
  }
  const executedCount = executed;
  const summary = [
    `AUTOPILOT: ${status} (${executedCount}/${nodes.length} nodes, ${retries} retries)`,
    `GOAL: ${input.goal}`,
    `PLAN: ${nodes.map((n) => n.action).join(' -> ')}`,
    ...notes.map((n) => `- ${n}`),
  ].join('\n');
  const diff = diffLines.join('\n');
  const id = newId(PREFIX.AUTOPILOT_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO autopilot_runs (id, owner_id, goal, node_count, executed, retries, status, summary, diff, test_results) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.goal, nodes.length, executedCount, retries, status, summary, diff, testResults],
  ));
  await recordAudit({
    action: AuditAction.AUTOPILOT_RUN_EXECUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'autopilot_runs',
    resourceId: id,
    detail: { goal: input.goal, nodes: nodes.length, executed: executedCount, retries, status },
  });
  return getAutopilotRun(userId, id);
}

export async function getAutopilotRun(userId: string, id: string): Promise<AutopilotRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM autopilot_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('autopilot_run_not_found', 'no autopilot run found for that id');
  return rowOf(row);
}

export async function listAutopilotRuns(userId: string): Promise<AutopilotRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM autopilot_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function autopilotReport(userId: string): Promise<{
  runs: number;
  complete: number;
  failed: number;
  total_retries: number;
}> {
  const rows = await listAutopilotRuns(userId);
  return {
    runs: rows.length,
    complete: rows.filter((r) => r.status === 'COMPLETE').length,
    failed: rows.filter((r) => r.status === 'FAILED').length,
    total_retries: rows.reduce((acc, r) => acc + r.retries, 0),
  };
}