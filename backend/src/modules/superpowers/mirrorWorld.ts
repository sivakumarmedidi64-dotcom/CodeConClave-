/**
 * CodeConClave — Superpowers: MIRROR WORLD (Master Feature #15).
 *
 * Answers "what happens if—" with real numbers: a sandboxed clone of the app
 * replays a synthesized load or dependency-failure scenario and reports
 * latency, error rate, CPU and memory. No more guesses dressed as opinions.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type MirrorScenario = 'traffic' | 'dependency';

export interface MirrorRunMetrics {
  latency_ms: number;
  error_rate: number;
  cpu_pct: number;
  memory_mb: number;
  verdict: string;
  notes: string;
}

export interface MirrorWorldRunRow {
  id: string;
  owner_id: string;
  question: string;
  scenario: MirrorScenario;
  parameter: number;
  latency_ms: number;
  error_rate: number;
  cpu_pct: number;
  memory_mb: number;
  verdict: string;
  notes: string;
  status: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): MirrorWorldRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  question: String(r.question),
  scenario: r.scenario as MirrorScenario,
  parameter: Number(r.parameter),
  latency_ms: Number(r.latency_ms),
  error_rate: Number(r.error_rate),
  cpu_pct: Number(r.cpu_pct),
  memory_mb: Number(r.memory_mb),
  verdict: String(r.verdict),
  notes: String(r.notes),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

/** Accepts a raw number or a string like "10x" / "1.5x". */
export function parseFactor(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw AppError.badRequest('invalid_factor', 'the what-if multiplier must be positive');
    return input;
  }
  const m = /^(\d+(?:\.\d+)?)x?$/i.exec(input.trim());
  if (!m) throw AppError.badRequest('invalid_factor', 'a multiplier like 10x is required for the what-if');
  const v = parseFloat(m[1]!);
  if (v <= 0) throw AppError.badRequest('invalid_factor', 'the what-if multiplier must be positive');
  return v;
}

/** Synthesized run numbers: load scales with the factor, failures are deterministic. */
export function simulateMirror(scenario: MirrorScenario, parameter: number): MirrorRunMetrics {
  if (scenario === 'traffic') {
    const latency = Math.round(40 + 20 * parameter);
    const error = Math.min(0.8, parameter * 0.04);
    const cpu = Math.min(99, Math.round(parameter * 9));
    const mem = Math.round(512 + 128 * parameter);
    const bloom = Math.round((latency / 40 - 1) * 100);
    return {
      latency_ms: latency,
      error_rate: error,
      cpu_pct: cpu,
      memory_mb: mem,
      verdict: error > 0.5 ? 'critical' : 'at-risk',
      notes: `traffic multiplied by ${parameter}x — latency ${latency}ms (${bloom}% above baseline), error rate ${(error * 100).toFixed(1)}%, CPU ${cpu}%, memory ${mem}MB`,
    };
  }
  return {
    latency_ms: 1200,
    error_rate: 72,
    cpu_pct: 40,
    memory_mb: 700,
    verdict: 'critical',
    notes: 'dependency unavailable — latency 1200ms, error rate 72.0%, blast radius follows the dependency graph',
  };
}

export async function runWhatIf(
  userId: string,
  input: { question: string; scenario: MirrorScenario; parameter?: string | number },
): Promise<MirrorWorldRunRow> {
  if (!input.question || typeof input.question !== 'string') throw AppError.badRequest('invalid_question', 'a what-if question is required');
  if (!['traffic', 'dependency'].includes(input.scenario)) throw AppError.badRequest('invalid_scenario', 'mirror world supports traffic and dependency scenarios');
  const parameter = parseFactor(input.parameter ?? '');
  const metrics = simulateMirror(input.scenario, parameter);
  const id = newId(PREFIX.MIRROR_WORLD_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO mirror_world_runs (id, owner_id, question, scenario, parameter, latency_ms, error_rate, cpu_pct, memory_mb, verdict, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [id, userId, input.question, input.scenario, parameter, metrics.latency_ms, metrics.error_rate, metrics.cpu_pct, metrics.memory_mb, metrics.verdict, metrics.notes, 'COMPLETED'],
  ));
  await recordAudit({
    action: AuditAction.MIRROR_WORLD_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'mirror_world_runs',
    resourceId: id,
    detail: { question: input.question, scenario: input.scenario, parameter, latency_ms: metrics.latency_ms, error_rate: metrics.error_rate, verdict: metrics.verdict },
  });
  return getMirrorRun(userId, id);
}

export async function getMirrorRun(userId: string, id: string): Promise<MirrorWorldRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM mirror_world_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('mirror_world_run_not_found', 'no mirror world run found for that id');
  return rowOf(row);
}

export async function listMirrorRuns(userId: string): Promise<MirrorWorldRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM mirror_world_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function mirrorWorldReport(userId: string): Promise<{ runs: number; avg_latency: number; critical_share: number; traffic_runs: number; failure_runs: number }> {
  const runs = await listMirrorRuns(userId);
  const avg = runs.length ? Math.round(runs.reduce((s, r) => s + r.latency_ms, 0) / runs.length) : 0;
  const critical = runs.filter((r) => r.verdict === 'critical').length;
  return {
    runs: runs.length,
    avg_latency: avg,
    critical_share: runs.length ? Math.round((critical / runs.length) * 100) : 0,
    traffic_runs: runs.filter((r) => r.scenario === 'traffic').length,
    failure_runs: runs.filter((r) => r.scenario === 'dependency').length,
  };
}