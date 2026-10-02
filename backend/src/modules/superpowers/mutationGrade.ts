/**
 * CodeConClave — Superpowers: MUTATION-GRADE TESTS (Master Feature #36).
 *
 * Not "did the test run" but "did the test actually fail when we broke the code
 * on purpose?" Every test case is graded against an intentionally-mutated copy
 * of the code; a test that still passes under mutation is HOLLOW and rejected.
 * Only tests that actually detect change ship.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type MutationOutcome = 'PASS' | 'FAIL';
export type MutationVerdict = 'SENSITIVE' | 'HOLLOW';

export interface MutationCase {
  file: string;
  function_name: string;
  test_body: string;
  mutated_outcome: MutationOutcome;
}

export interface MutationSweepRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  targets: number;
  sensitive: number;
  hollow: number;
  accepted: Array<{ file: string; function_name: string }>;
  rejected: Array<{ file: string; function_name: string; reasons: string[] }>;
  created_at: Date;
}

const asList = <T>(v: unknown): T[] => {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T[]; } catch { return [] as T[]; }
  }
  if (Array.isArray(v)) return v as T[];
  return [] as T[];
};

const rowOf = (r: Record<string, unknown>): MutationSweepRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  targets: Number(r.targets ?? 0),
  sensitive: Number(r.sensitive ?? 0),
  hollow: Number(r.hollow ?? 0),
  accepted: asList<{ file: string; function_name: string }>(r.accepted),
  rejected: asList<{ file: string; function_name: string; reasons: string[] }>(r.rejected),
  created_at: new Date(r.created_at as string),
});

const ASSERTION_LIKE = /\b(?:expect|assert|should|throws?|rejects?)\s*\(/i;
const PLACEHOLDER_LIKE = /\b(?:TODO|FIXME|placeholder|dummy)\b|^\s*pass\s*;?\s*$|console\.log/mi;

/** The set of deterministic code mutations the grader applies to try to fool a test. */
const TRANSFORMS: Array<{ key: string; apply: (s: string) => string }> = [
  { key: 'INVERT_EQUALITY', apply: (s) => s.replace('===', '!==') },
  { key: 'INVERT_INEQUALITY', apply: (s) => s.replace('!==', '===') },
  { key: 'FLIP_BOUND', apply: (s) => s.replace('>=', '>') },
  { key: 'FLIP_CAP', apply: (s) => s.replace('<=', '<') },
  { key: 'OFF_BY_MAX', apply: (s) => s.replace('length - 1', 'length') },
  { key: 'SWAP_AND', apply: (s) => s.replace('&&', '||') },
  { key: 'BREAK_GUARD', apply: (s) => s.replace('!== null', '=== null') },
  { key: 'INVERT_RETURN', apply: (s) => s.replace(/\breturn\s+(true|false)\b/, (_, v: string) => (v === 'true' ? 'return false' : 'return true')) },
];

export interface MutationGenerated {
  key: string;
  code: string;
}

export function mutateSnippet(input: { functionName: string; body: string }): { functionName: string; mutations: MutationGenerated[] } {
  const { functionName, body } = input;
  if (!functionName || typeof functionName !== 'string') throw AppError.badRequest('invalid_function_name', 'mutation needs a target function name');
  if (typeof body !== 'string' || body.trim().length === 0) throw AppError.badRequest('empty_body', 'mutation needs a non-empty code body');
  const mutations: MutationGenerated[] = [];
  for (const t of TRANSFORMS) {
    const mutated = t.apply(body);
    if (mutated !== body) mutations.push({ key: t.key, code: mutated });
  }
  return { functionName, mutations };
}

export function gradeTestForMutation(input: { testBody: string; targetFunction: string; mutatedOutcome: MutationOutcome }): { verdict: MutationVerdict; reasons: string[] } {
  const { testBody, targetFunction, mutatedOutcome } = input;
  const reasons: string[] = [];
  if (mutatedOutcome === 'PASS') reasons.push('passes under mutation: did not detect the intentionally broken code');
  if (!testBody.includes(targetFunction)) reasons.push(`never references the target "${targetFunction}" — it is not bound to the code it claims to test`);
  if (!ASSERTION_LIKE.test(testBody)) reasons.push('contains no assertion');
  if (PLACEHOLDER_LIKE.test(testBody)) reasons.push('looks like a placeholder, not a real test');
  return { verdict: reasons.length > 0 ? 'HOLLOW' : 'SENSITIVE', reasons };
}

export interface MutationSweepReport {
  id: string;
  targets: number;
  sensitive: number;
  hollow: number;
  verdict: 'SHIP' | 'REJECT_HOLLOW_TESTS';
  accepted: Array<{ file: string; function_name: string }>;
  rejected: Array<{ file: string; function_name: string; reasons: string[] }>;
}

export async function runMutationSweep(userId: string, input: { projectId?: string | null; cases: MutationCase[] }): Promise<MutationSweepReport> {
  const cases = Array.isArray(input.cases) ? input.cases : [];
  if (cases.length === 0) throw AppError.badRequest('empty_cases', 'mutation sweep needs at least one test case');
  const accepted: Array<{ file: string; function_name: string }> = [];
  const rejected: Array<{ file: string; function_name: string; reasons: string[] }> = [];
  for (const c of cases) {
    if (!c.file || !c.function_name || typeof c.test_body !== 'string') throw AppError.badRequest('invalid_case', 'each case needs file, function_name and test_body');
    const grade = gradeTestForMutation({ testBody: c.test_body, targetFunction: c.function_name, mutatedOutcome: c.mutated_outcome });
    if (grade.verdict === 'SENSITIVE') accepted.push({ file: c.file, function_name: c.function_name });
    else rejected.push({ file: c.file, function_name: c.function_name, reasons: grade.reasons });
  }
  const id = newId(PREFIX.MUTATION_SWEEP);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO mutation_sweeps (id, owner_id, project_id, targets, sensitive, hollow, accepted, rejected) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.projectId ?? null, cases.length, accepted.length, rejected.length, JSON.stringify(accepted), JSON.stringify(rejected)],
  ));
  await recordAudit({
    action: AuditAction.MUTATION_SWEEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'mutation_sweeps',
    resourceId: id,
    detail: { targets: cases.length, sensitive: accepted.length, hollow: rejected.length },
  });
  for (const r of rejected) {
    await recordAudit({
      action: AuditAction.MUTATION_HOLLOW_REJECTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'mutation_sweeps',
      resourceId: id,
      detail: { file: r.file, function_name: r.function_name, reasons: r.reasons },
    });
  }
  const verdict = rejected.length > 0 ? 'REJECT_HOLLOW_TESTS' : 'SHIP';
  return { id, targets: cases.length, sensitive: accepted.length, hollow: rejected.length, verdict, accepted, rejected };
}

export async function getMutationSweep(userId: string, id: string): Promise<MutationSweepRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM mutation_sweeps WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('mutation_sweep_not_found', 'no mutation sweep found for that id');
  return rowOf(row);
}

export async function listMutationSweeps(userId: string): Promise<MutationSweepRow[]> {
  const rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM mutation_sweeps WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  return rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function mutationReport(userId: string): Promise<{
  sweeps: number;
  targets: number;
  sensitive: number;
  hollow: number;
  hollow_shipwatch: number;
}> {
  const rows = await listMutationSweeps(userId);
  return {
    sweeps: rows.length,
    targets: rows.reduce((n, r) => n + r.targets, 0),
    sensitive: rows.reduce((n, r) => n + r.sensitive, 0),
    hollow: rows.reduce((n, r) => n + r.hollow, 0),
    hollow_shipwatch: rows.filter((r) => r.hollow > 0).length,
  };
}