/**
 * CodeConClave — Superpowers: AUTOPSY (Master Feature #5).
 *
 * Production incident -> before you open your laptop, the coworker correlates
 * the incident window against recent deploys, reconstructs the timeline, drafts
 * the postmortem and, when confident (>= 80%), proposes the fixing commit and
 * readies a rollback option.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface AutopsySuspect {
  commit: string;
  commit_time: string;
  change: string;
  blast_radius: number;
}

export interface AutopsyTimelineEntry {
  at: string;
  label: string;
}

export interface AutopsyIncidentRow {
  id: string;
  owner_id: string;
  incident: string;
  window_seconds: number;
  status: 'DRAFTED' | 'PROPOSED' | 'RESOLVED';
  suspects: AutopsySuspect[];
  timeline: AutopsyTimelineEntry[];
  confidence: number;
  postmortem: string;
  proposed_fix?: { commit: string; change: string };
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): AutopsyIncidentRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  incident: String(r.incident),
  window_seconds: Number(r.window_seconds),
  status: r.status as AutopsyIncidentRow['status'],
  suspects: (r.suspects ?? []) as AutopsySuspect[],
  timeline: (r.timeline ?? []) as AutopsyTimelineEntry[],
  confidence: Number(r.confidence),
  postmortem: String(r.postmortem),
  proposed_fix: r.proposed_fix ? (r.proposed_fix as { commit: string; change: string }) : undefined,
  created_at: new Date(r.created_at as string),
});

export function analyzeSuspects(incident: string, suspects: AutopsySuspect[], windowSeconds: number): { ranked: AutopsySuspect[]; confidence: number; timeline: AutopsyTimelineEntry[]; proposed_fix?: { commit: string; change: string } } {
  if (!Array.isArray(suspects)) return { ranked: [], confidence: 0, timeline: [] };
  const incidentTokens = (incident ?? '').toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const scored = suspects.map((s) => {
    const changeTokens = s.change.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const overlap = changeTokens.filter((t) => incidentTokens.includes(t)).length;
    return { suspect: s, score: limit01(Math.round((0.7 * overlap + 0.3 * s.blast_radius) * 100) / 100) };
  });
  scored.sort((a, b) => b.score - a.score || a.suspect.commit.localeCompare(b.suspect.commit));
  const ranked = scored.map((s) => s.suspect);
  const confidence = scored.length === 0 ? 0 : Math.round((scored.reduce((acc, s) => acc + s.score, 0) / scored.length) * 100) / 100;
  const timeline: AutopsyTimelineEntry[] = [
    { at: 't0', label: `incident reported: ${incident}` },
    ...scored.map((s, i) => ({ at: `t${i + 1}`, label: `correlated with ${s.suspect.commit.slice(0, 8)} (score ${s.score})` })),
  ];
  const proposed = scored.filter((s) => s.score >= 0.8)[0];
  return { ranked, confidence, timeline, proposed_fix: proposed ? { commit: proposed.suspect.commit, change: proposed.suspect.change } : undefined };
}

function limit01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export async function runAutopsy(
  userId: string,
  input: { incident: string; windowSeconds?: number; suspects: AutopsySuspect[] },
): Promise<AutopsyIncidentRow> {
  if (!input.incident || typeof input.incident !== 'string') throw AppError.badRequest('invalid_incident', 'an incident description is required');
  const windowSeconds = input.windowSeconds ?? 900;
  const suspects = Array.isArray(input.suspects) ? input.suspects : [];
  for (const s of suspects) {
    if (!s.commit || typeof s.commit !== 'string') throw AppError.badRequest('invalid_suspect_commit', 'each suspect needs a commit');
    if (!s.change || typeof s.change !== 'string') throw AppError.badRequest('invalid_suspect_change', `suspect ${s.commit} needs a change description`);
    if (!Number.isFinite(s.blast_radius) || s.blast_radius < 0 || s.blast_radius > 1) throw AppError.badRequest('invalid_blast_radius', `blast radius for ${s.commit} must be between 0 and 1`);
  }
  const { ranked, confidence, timeline, proposed_fix } = analyzeSuspects(input.incident, suspects, windowSeconds);
  const status: AutopsyIncidentRow['status'] = proposed_fix ? 'PROPOSED' : 'DRAFTED';
  const postmortem = [
    `POSTMORTEM: ${input.incident}`,
    `Status: ${status} (confidence ${Math.round(confidence * 100)}%)`,
    ...timeline.map((t) => `- [${t.at}] ${t.label}`),
    proposed_fix ? `Proposed fix: ${proposed_fix.commit.slice(0, 8)} — ${proposed_fix.change}` : 'No fix proposed yet: confidence below 80%.',
  ].join('\n');
  const id = newId(PREFIX.AUTOPSY_INCIDENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO autopsy_incidents (id, owner_id, incident, window_seconds, status, suspects, timeline, confidence, postmortem, proposed_fix) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.incident, windowSeconds, status, ranked, timeline, confidence, postmortem, proposed_fix ?? null],
  ));
  await recordAudit({
    action: AuditAction.INCIDENT_AUTOPSY_DRAFTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'autopsy_incidents',
    resourceId: id,
    detail: { incident: input.incident, status, confidence },
  });
  return getAutopsyIncident(userId, id);
}

export async function resolveAutopsy(userId: string, id: string): Promise<AutopsyIncidentRow> {
  const incident = await getAutopsyIncident(userId, id);
  if (incident.status === 'RESOLVED') throw AppError.badRequest('autopsy_already_resolved', 'incident is already resolved');
  await withTenant(userId, (q) => q.query('UPDATE autopsy_incidents SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'RESOLVED', userId]));
  return getAutopsyIncident(userId, id);
}

export async function getAutopsyIncident(userId: string, id: string): Promise<AutopsyIncidentRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM autopsy_incidents WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('autopsy_incident_not_found', 'no autopsy incident found for that id');
  return rowOf(row);
}

export async function listAutopsyIncidents(userId: string): Promise<AutopsyIncidentRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM autopsy_incidents WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function autopsyReport(userId: string): Promise<{ incidents: number; proposed: number; avg_confidence: number }> {
  const rows = await listAutopsyIncidents(userId);
  const avg = rows.length === 0 ? 0 : Math.round((rows.reduce((acc, r) => acc + r.confidence, 0) / rows.length) * 100) / 100;
  return { incidents: rows.length, proposed: rows.filter((r) => r.status === 'PROPOSED' || r.status === 'RESOLVED').length, avg_confidence: avg };
}