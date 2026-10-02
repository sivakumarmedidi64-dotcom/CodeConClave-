/**
 * CodeConClave — Superpowers: SPEC LINTER (Master Feature #13).
 *
 * Continuous truth checker: documented endpoints / env vars / SLAs must match
 * reality. Drift is detected and recorded with evidence, never silently
 * hidden. Checks are run lazily and pinned as OK / DRIFT with the last-check
 * timestamp so the UI can show a live truth table for the product.
 *
 *   - ENV_VAR  : process.env[name] must be non-empty.
 *   - ENDPOINT : the route must exist in the live express app (given by the
 *                route table at check time).
 *   - SLA      : a measured metric must satisfy the expectation string
 *                (evaluated deterministically by the provided probe).
 */
import { withTenant, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const SpecKind = ['ENDPOINT', 'ENV_VAR', 'SLA'] as const;
export type SpecKind = (typeof SpecKind)[number];
export const SpecStatus = ['UNCHECKED', 'OK', 'DRIFT'] as const;
export type SpecStatus = (typeof SpecStatus)[number];

export interface SpecEntryInput {
  kind: SpecKind;
  name: string;
  expectation?: string;
  projectId?: string | null;
}

export interface SpecEntryRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  kind: SpecKind;
  name: string;
  expectation: string | null;
  status: SpecStatus;
  evidence: Record<string, unknown>;
  last_checked_at: Date | null;
  created_at: Date;
}

export interface SpecCheckReport {
  total: number;
  ok: number;
  drift: number;
  entries: Array<SpecEntryRow & { detail?: string }>;
}

function rowOf(r: Record<string, unknown>): SpecEntryRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    kind: (r.kind as SpecKind) ?? 'ENDPOINT',
    name: String(r.name),
    expectation: r.expectation === null ? null : String(r.expectation),
    status: (r.status as SpecStatus) ?? 'UNCHECKED',
    evidence: r.evidence && typeof r.evidence === 'object' ? (r.evidence as Record<string, unknown>) : {},
    last_checked_at: r.last_checked_at === null ? null : new Date(String(r.last_checked_at)),
    created_at: new Date(String(r.created_at)),
  };
}

function normalizeKind(value: string | null | undefined): SpecKind {
  const v = (value ?? '').toUpperCase();
  return (SpecKind as readonly string[]).includes(v) ? (v as SpecKind) : 'ENDPOINT';
}

export async function upsertSpecEntry(userId: string, input: SpecEntryInput): Promise<SpecEntryRow> {
  const kind = normalizeKind(input.kind);
  const name = (input.name ?? '').trim();
  if (!name) throw AppError.badRequest('spec_name_required', 'A spec name is required');
  const id = newId(PREFIX.SPEC_ENTRY);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO spec_entries (id, owner_id, project_id, kind, name, expectation, status)
     VALUES ($1,$2,$3,$4,$5,$6,'UNCHECKED')
     ON CONFLICT DO NOTHING`,
    [id, userId, input.projectId ?? null, kind, name, input.expectation?.trim()?.slice(0, 500) ?? null],
  ));
  await recordAudit({
    action: AuditAction.SPEC_ENTRY_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'spec_entries',
    resourceId: id,
    detail: { kind, name: name.slice(0, 200) },
  });
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM spec_entries WHERE id = $1 AND owner_id = $2', [id, userId])).rows,
  );
  return rowOf(rows[0]!);
}

export async function listSpecEntries(userId: string, opts: { kind?: SpecKind; projectId?: string } = {}): Promise<SpecEntryRow[]> {
  const conditions: string[] = ['owner_id = $1'];
  const params: unknown[] = [userId];
  if (opts.kind) {
    params.push(opts.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    conditions.push(`project_id = $${params.length}`);
  }
  return (await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        `SELECT * FROM spec_entries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
        params,
      )
    ).rows,
  )).map(rowOf);
}

export type SpecProbe = (entry: SpecEntryRow) => { ok: boolean; detail?: string; evidence?: Record<string, unknown> };

/** Live route registry, populated by app.ts after assembly so ENDPOINT specs
 *  are checked against the backend's REAL route table. */
const routeRegistry = new Set<string>();
export function registerKnownRoutes(routes: string[]): void {
  for (const r of routes) routeRegistry.add(r);
}
export function isRouteKnown(route: string): boolean {
  return routeRegistry.has(route);
}

const envProbe: SpecProbe = (entry) => {
  const value = typeof process !== 'undefined' ? process.env[entry.name] : undefined;
  const ok = !!value && value.trim().length > 0;
  return { ok, detail: ok ? 'present' : 'missing or empty', evidence: { name: entry.name } };
};

/**
 * Run the linter across the registered specs. `routeExists` is supplied by the
 * caller (the live express app) and `slaProbe` optionally by the caller for SLA
 * entries. Every check pins status + evidence with a timestamp; drift is never
 * silently dropped. Only spec entries owned by the caller are touched.
 */
export async function runSpecChecks(
  userId: string,
  deps: { routeExists?: (route: string) => boolean; slaProbe?: SpecProbe },
  opts: { projectId?: string } = {},
): Promise<SpecCheckReport> {
  const entries = await listSpecEntries(userId, opts);
  const routeExists = deps.routeExists ?? isRouteKnown;
  const report: SpecCheckReport = { total: entries.length, ok: 0, drift: 0, entries: [] };
  for (const entry of entries) {
    let ok = false;
    let detail: string | undefined;
    let evidence: Record<string, unknown> = {};
    if (entry.kind === 'ENV_VAR') {
      const probe = envProbe(entry);
      ok = probe.ok; detail = probe.detail; evidence = probe.evidence ?? {};
    } else if (entry.kind === 'ENDPOINT') {
      const found = routeExists(entry.name);
      ok = found;
      detail = found ? 'route registered' : 'route not registered';
      evidence = { route: entry.name };
    } else {
      const probe = deps.slaProbe ? deps.slaProbe(entry) : { ok: false, detail: 'no SLA probe supplied', evidence: {} };
      ok = probe.ok; detail = probe.detail; evidence = probe.evidence ?? {};
    }
    const status: SpecStatus = ok ? 'OK' : 'DRIFT';
    if (status === 'OK') report.ok += 1;
    else report.drift += 1;
    await withTenant(userId, (q) => q.query(
      `UPDATE spec_entries SET status = $2, evidence = $3::jsonb, last_checked_at = now()
       WHERE id = $1 AND owner_id = $4`,
      [entry.id, status, JSON.stringify({ ...evidence, detail: detail ?? '' }), userId],
    ));
    report.entries.push({ ...rowOf({ ...entry, status, evidence: { ...evidence, detail: detail ?? '' } }), detail });
  }
  await recordAudit({
    action: AuditAction.SPEC_CHECK_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'spec_entries',
    resourceId: null,
    detail: { total: report.total, ok: report.ok, drift: report.drift },
  });
  return report;
}