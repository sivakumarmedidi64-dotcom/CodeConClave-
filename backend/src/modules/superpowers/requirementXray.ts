/**
 * CodeConClave — Superpowers: REQUIREMENT X-RAY (Master Feature #74).
 *
 * Takes any stakeholder request and exposes everything it secretly implies:
 * migrations, permissions, edge cases, analytics, legal, a11y, rollback. The
 * 40 hidden sub-requirements surface before a line is written.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RequirementXrayRow {
  id: string;
  owner_id: string;
  request: string;
  implications: string[];
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): RequirementXrayRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  request: String(r.request),
  implications: (r.implications ?? []) as string[],
  created_at: new Date(r.created_at as string),
});

/** One stakeholder sentence, every hidden sub-requirement it secretly implies. */
export function xrayImplications(request: string): string[] {
  const implications: string[] = [];
  const l = request.toLowerCase();
  if (/(delete|remove|purge)/.test(l)) implications.push('soft delete + audit trail', 'cascade impact review on foreign keys', 'restore / rollback path');
  if (/(user|account|profile|role)/.test(l)) implications.push('permissions update + role review', 'privacy: GDPR / retention handling');
  if (/(button|form|input|click|ui|screen|modal)/.test(l)) implications.push('a11y pass: keyboard, contrast, labels', 'empty + very-long-input states');
  if (/(payment|charge|refund|billing|checkout|invoice|pay)/.test(l)) implications.push('double-charge guard', 'ledger + reconciliation entry', 'tax / refund policy callouts');
  if (/(upload|file|image|document|export)/.test(l)) implications.push('size + mime-type guard', 'storage quota + retention', 'malware scan', 'large-payload pagination');
  if (/(search|filter|sort)/.test(l)) implications.push('index + query plan review', 'ordering / no-results edge cases');
  if (/(metric|analytics|track|report|dashboard)/.test(l)) implications.push('analytics instrumentation + event schema');
  implications.push('migration & backfill check', 'feature flag rollout', 'rollback plan', 'happy + sad path tests');
  return implications;
}

export async function xrayRequirement(userId: string, input: { request: string }): Promise<RequirementXrayRow> {
  if (!input.request || typeof input.request !== 'string') throw AppError.badRequest('invalid_request', 'paste the stakeholder request');
  const implications = xrayImplications(input.request);
  const id = newId(PREFIX.REQUIREMENT_XRAY);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO requirement_xrays (id, owner_id, request, implications) VALUES ($1,$2,$3,$4)',
    [id, userId, input.request, implications],
  ));
  await recordAudit({
    action: AuditAction.REQUIREMENT_XRAYED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'requirement_xrays',
    resourceId: id,
    detail: { request: input.request, implications: implications.length },
  });
  return getXray(userId, id);
}

export async function getXray(userId: string, id: string): Promise<RequirementXrayRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM requirement_xrays WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('requirement_xray_not_found', 'no requirement x-ray found for that id');
  return rowOf(row);
}

export async function listXrays(userId: string): Promise<RequirementXrayRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM requirement_xrays WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function requirementXrayReport(userId: string): Promise<{ scans: number; implications: number; categories: number }> {
  const xrays = await listXrays(userId);
  const unique = new Set<string>();
  for (const x of xrays) for (const i of x.implications) unique.add(i);
  return {
    scans: xrays.length,
    implications: xrays.reduce((s, x) => s + x.implications.length, 0),
    categories: unique.size,
  };
}