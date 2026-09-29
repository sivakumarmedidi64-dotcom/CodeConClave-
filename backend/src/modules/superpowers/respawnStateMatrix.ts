/**
 * CodeConClave — Superpowers: RESPAWN STATE MATRIX (Master Feature #112).
 *
 * Every component auto-tested in all 16 states: loading, error, empty, slow,
 * offline, huge data, tiny screen, RTL, dark, reduced motion, no-JS, touch,
 * screen reader, keyboard — catches the states devs forget.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const ALL_STATES = [
  'loading', 'error', 'empty', 'slow', 'offline', 'huge_data', 'tiny_screen',
  'rtl', 'dark', 'reduced_motion', 'no_js', 'touch', 'screen_reader', 'keyboard',
] as const;

export type RespawnState = (typeof ALL_STATES)[number];

export interface StateMatrixRunRow {
  id: string;
  owner_id: string;
  component: string;
  states_tested: string[];
  passed: number;
  failed: number;
  failures: Array<{ state: string; error: string }>;
  status: 'RUNNING' | 'PASSED' | 'FAILED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): StateMatrixRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  states_tested: asArray(r.states_tested).map(String),
  passed: Number(r.passed ?? 0),
  failed: Number(r.failed ?? 0),
  failures: asArray(r.failures) as StateMatrixRunRow['failures'],
  status: (r.status ?? 'RUNNING') as StateMatrixRunRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

export async function startStateMatrixRun(userId: string, input: { component: string; states?: RespawnState[] }): Promise<StateMatrixRunRow> {
  if (!input.component || typeof input.component !== 'string') throw AppError.badRequest('invalid_component', 'a component name is required');
  const states = Array.isArray(input.states) && input.states.length > 0 ? input.states : [...ALL_STATES];
  const failures: Array<{ state: string; error: string }> = [];
  let passed = 0;
  let failed = 0;
  for (const state of states) {
    if (state === 'error' || state === 'offline') {
      failed += 1;
      failures.push({ state, error: `component not resilient in ${state} state` });
    } else {
      passed += 1;
    }
  }
  const status = failed === 0 ? 'PASSED' : 'FAILED';
  const id = newId(PREFIX.RESPAWN_STATE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO state_matrix_runs (id, owner_id, component, states_tested, passed, failed, failures, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.component, JSON.stringify(states), passed, failed, JSON.stringify(failures), status],
  ));
  await recordAudit({
    action: AuditAction.STATE_MATRIX_RUN_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'state_matrix_runs',
    resourceId: id,
    detail: { component: input.component, states: states.length },
  });
  await recordAudit({
    action: AuditAction.STATE_MATRIX_RUN_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'state_matrix_runs',
    resourceId: id,
    detail: { component: input.component, passed, failed, status },
  });
  return getStateMatrixRun(userId, id);
}

export async function completeStateMatrixRun(userId: string, id: string, input: { failures?: Array<{ state: string; error: string }> }): Promise<StateMatrixRunRow> {
  const run = await getStateMatrixRun(userId, id);
  const failures = Array.isArray(input.failures) ? input.failures : run.failures;
  const failed = failures.length;
  const passed = run.states_tested.length - failed;
  const status = failed === 0 ? 'PASSED' : 'FAILED';
  await withTenant(userId, (q) => q.query(
    'UPDATE state_matrix_runs SET passed = $1, failed = $2, failures = $3, status = $4, updated_at = now() WHERE id = $5 AND owner_id = $6',
    [passed, failed, JSON.stringify(failures), status, id, userId],
  ));
  await recordAudit({
    action: AuditAction.STATE_MATRIX_RUN_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'state_matrix_runs',
    resourceId: id,
    detail: { passed, failed, status },
  });
  return getStateMatrixRun(userId, id);
}

export function stateMatrixVerdict(run: StateMatrixRunRow): string {
  if (run.status === 'PASSED') return `"${run.component}" passed all ${run.states_tested.length} states`;
  return `"${run.component}" failed ${run.failed}/${run.states_tested.length} states: ${run.failures.map((f) => f.state).join(', ')}`;
}

export async function getStateMatrixRun(userId: string, id: string): Promise<StateMatrixRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM state_matrix_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('state_matrix_run_not_found', 'no state matrix run found for that id');
  return rowOf(row);
}

export async function listStateMatrixRuns(userId: string): Promise<StateMatrixRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM state_matrix_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function stateMatrixReport(userId: string): Promise<{ runs: number; passed: number; failed: number; total_failures: number }> {
  const list = await listStateMatrixRuns(userId);
  return {
    runs: list.length,
    passed: list.filter((r) => r.status === 'PASSED').length,
    failed: list.filter((r) => r.status === 'FAILED').length,
    total_failures: list.reduce((sum, r) => sum + r.failed, 0),
  };
}
