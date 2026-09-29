/**
 * CodeConClave — Superpowers: SHADOW EXECUTION (Master Feature #39).
 *
 * For critical paths the new build runs in a shadow environment against
 * mirrored, read-only production traffic; latency, errors and response bodies
 * are compared probe-by-probe. Any mismatch blocks the production release —
 * airline-grade confidence for a deploy, automatic.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type ShadowVerdict = 'PASS' | 'BLOCKED';

export interface ShadowProbe {
  status: number;
  latencyMs: number;
  body?: unknown;
  error?: string | null;
}

export interface MirrorEntry {
  requestKey: string;
  control: ShadowProbe;
  candidate: ShadowProbe;
}

export interface MismatchDetail {
  requestKey: string;
  reasons: string[];
}

export interface ShadowRunRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  release_ref: string;
  mirrored: number;
  mismatches: number;
  verdict: ShadowVerdict;
  mismatches_detail: MismatchDetail[];
  created_at: Date;
}

const asList = <T>(v: unknown): T[] => {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T[]; } catch { return [] as T[]; }
  }
  if (Array.isArray(v)) return v as T[];
  return [] as T[];
};

const rowOf = (r: Record<string, unknown>): ShadowRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  release_ref: String(r.release_ref),
  mirrored: Number(r.mirrored ?? 0),
  mismatches: Number(r.mismatches ?? 0),
  verdict: (r.verdict ?? 'PASS') as ShadowVerdict,
  mismatches_detail: asList<MismatchDetail>(r.mismatches_detail),
  created_at: new Date(r.created_at as string),
});

/** Canonical, order-independent form of a response body (JSON or plain text). */
export function normalizeBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return body.trim(); }
  }
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = sorted((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sorted(parsed));
}

export interface ComparisonResult {
  statusMatch: boolean;
  bodyMatch: boolean;
  errorMatch: boolean;
  latencyDelta: number;
  mismatch: boolean;
  reasons: string[];
}

const asNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function compareResponses(control: ShadowProbe, candidate: ShadowProbe, thresholdMs = 250): ComparisonResult {
  const reasons: string[] = [];
  const statusMatch = asNumber(control.status) === asNumber(candidate.status);
  if (!statusMatch) reasons.push(`status ${control.status} -> ${candidate.status}`);
  const bodyMatch = normalizeBody(control.body) === normalizeBody(candidate.body);
  if (!bodyMatch) reasons.push('response body differs');
  const controlError = Boolean(control.error);
  const candidateError = Boolean(candidate.error);
  const errorMatch = controlError === candidateError;
  if (!errorMatch) reasons.push('error presence differs');
  const latencyDelta = asNumber(candidate.latencyMs) - asNumber(control.latencyMs);
  if (latencyDelta > asNumber(thresholdMs)) reasons.push(`latency +${latencyDelta}ms exceeds threshold ${thresholdMs}ms`);
  return { statusMatch, bodyMatch, errorMatch, latencyDelta, mismatch: reasons.length > 0, reasons };
}

export async function runShadowComparison(userId: string, input: {
  projectId?: string | null;
  releaseRef: string;
  thresholdMs?: number;
  mirror: MirrorEntry[];
}): Promise<ShadowRunRow & { mismatches_detail: MismatchDetail[] }> {
  const mirror = Array.isArray(input.mirror) ? input.mirror : [];
  if (mirror.length === 0) throw AppError.badRequest('empty_mirror', 'shadow execution needs at least one mirrored request');
  const mismatches: MismatchDetail[] = [];
  for (const entry of mirror) {
    if (!entry.requestKey || !entry.control || !entry.candidate) throw AppError.badRequest('invalid_mirror_entry', 'each mirror entry needs requestKey, control and candidate probes');
    const result = compareResponses(entry.control, entry.candidate, input.thresholdMs);
    if (result.mismatch) mismatches.push({ requestKey: entry.requestKey, reasons: result.reasons });
  }
  const verdict: ShadowVerdict = mismatches.length > 0 ? 'BLOCKED' : 'PASS';
  const id = newId(PREFIX.SHADOW_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO shadow_runs (id, owner_id, project_id, release_ref, mirrored, mismatches, verdict, mismatches_detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.projectId ?? null, input.releaseRef, mirror.length, mismatches.length, verdict, JSON.stringify(mismatches)],
  ));
  await recordAudit({
    action: AuditAction.SHADOW_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'shadow_runs',
    resourceId: id,
    detail: { releaseRef: input.releaseRef, mirrored: mirror.length, mismatches: mismatches.length, verdict },
  });
  if (verdict === 'BLOCKED') {
    for (const m of mismatches) {
      await recordAudit({
        action: AuditAction.SHADOW_MISMATCH,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'shadow_runs',
        resourceId: id,
        detail: { releaseRef: input.releaseRef, requestKey: m.requestKey, reasons: m.reasons },
      });
    }
  }
  return getShadowRun(userId, id);
}

export async function getShadowRun(userId: string, id: string): Promise<ShadowRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM shadow_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('shadow_run_not_found', 'no shadow run found for that id');
  return rowOf(row);
}

export async function listShadowRuns(userId: string, filter: { verdict?: ShadowVerdict; releaseRef?: string } = {}): Promise<ShadowRunRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM shadow_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.verdict) rows = rows.filter((r) => r.verdict === filter.verdict);
  if (filter.releaseRef) rows = rows.filter((r) => r.release_ref === filter.releaseRef);
  return rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}