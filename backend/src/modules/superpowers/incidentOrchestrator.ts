/**
 * CodeConClave — Superpowers: INCIDENT ORCHESTRATOR (Master Feature #97).
 *
 * Log spike triggers agent investigation, postmortem is drafted, and a
 * candidate fix PR is proposed — end-to-end incident response.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface IncidentOrchRunRow {
  id: string;
  owner_id: string;
  incident: string;
  log_spike: string;
  agent_investigation: string | null;
  postmortem_draft: string | null;
  fix_pr_url: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): IncidentOrchRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  incident: String(r.incident),
  log_spike: String(r.log_spike),
  agent_investigation: r.agent_investigation == null ? null : String(r.agent_investigation),
  postmortem_draft: r.postmortem_draft == null ? null : String(r.postmortem_draft),
  fix_pr_url: r.fix_pr_url == null ? null : String(r.fix_pr_url),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function triggerIncident(userId: string, input: { incident: string; log_spike: string }): Promise<IncidentOrchRunRow> {
  if (!input.incident || typeof input.incident !== 'string') throw AppError.badRequest('invalid_incident', 'an incident name is required');
  if (!input.log_spike || typeof input.log_spike !== 'string') throw AppError.badRequest('invalid_log_spike', 'log spike data is required');
  const id = newId(PREFIX.INCIDENT_ORCH_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO incident_orch_runs (id, owner_id, incident, log_spike, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.incident, input.log_spike, 'INVESTIGATING'],
  ));
  await recordAudit({
    action: AuditAction.INCIDENT_ORCH_TRIGGERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'incident_orch_runs',
    resourceId: id,
    detail: { incident: input.incident },
  });
  return getIncidentOrchRun(userId, id);
}

export async function draftPostmortem(userId: string, id: string, input: { findings: string }): Promise<IncidentOrchRunRow> {
  if (!input.findings || typeof input.findings !== 'string') throw AppError.badRequest('invalid_findings', 'findings are required for a postmortem');
  const run = await getIncidentOrchRun(userId, id);
  if (run.status !== 'INVESTIGATING') throw AppError.badRequest('postmortem_exists', 'postmortem already drafted for this incident');
  await withTenant(userId, (q) => q.query(
    'UPDATE incident_orch_runs SET postmortem_draft = $2, agent_investigation = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.findings, 'Agent investigation complete', 'POSTMORTEM_DRAFTED', userId],
  ));
  await recordAudit({
    action: AuditAction.INCIDENT_POSTMORTEM_DRAFTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'incident_orch_runs',
    resourceId: id,
    detail: { findings: input.findings },
  });
  return getIncidentOrchRun(userId, id);
}

export async function proposeFix(userId: string, id: string, input: { fix_pr_url: string }): Promise<IncidentOrchRunRow> {
  if (!input.fix_pr_url || typeof input.fix_pr_url !== 'string') throw AppError.badRequest('invalid_fix_pr_url', 'a fix PR url is required');
  const run = await getIncidentOrchRun(userId, id);
  if (run.status === 'FIX_PROPOSED') throw AppError.badRequest('fix_already_proposed', 'a fix has already been proposed');
  await withTenant(userId, (q) => q.query(
    'UPDATE incident_orch_runs SET fix_pr_url = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.fix_pr_url, 'FIX_PROPOSED', userId],
  ));
  await recordAudit({
    action: AuditAction.INCIDENT_FIX_PROPOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'incident_orch_runs',
    resourceId: id,
    detail: { fix_pr_url: input.fix_pr_url },
  });
  return getIncidentOrchRun(userId, id);
}

export async function getIncidentOrchRun(userId: string, id: string): Promise<IncidentOrchRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM incident_orch_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('incident_orch_run_not_found', 'no incident orch run found for that id');
  return rowOf(row);
}

export async function listIncidentOrchRuns(userId: string): Promise<IncidentOrchRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM incident_orch_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function incidentOrchReport(userId: string): Promise<{ runs: number; investigating: number; postmortem_drafted: number; fix_proposed: number }> {
  const runs = await listIncidentOrchRuns(userId);
  return {
    runs: runs.length,
    investigating: runs.filter((r) => r.status === 'INVESTIGATING').length,
    postmortem_drafted: runs.filter((r) => r.status === 'POSTMORTEM_DRAFTED').length,
    fix_proposed: runs.filter((r) => r.status === 'FIX_PROPOSED').length,
  };
}
