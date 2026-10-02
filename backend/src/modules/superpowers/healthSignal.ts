/**
 * CodeConClave — Superpowers: ENGINEERING SIXTH SENSE (Master Feature #155).
 *
 * One always-on indicator per project: GREEN / YELLOW / RED from tests, debt,
 * incidents, bus factor, velocity and security. This implementation is the
 * aggregator over the other intelligence tables — the single truthful signal a
 * founder reads at a glance:
 *
 *   RED    any CRITICAL risk band, OR >= 3 open fix tickets, OR >= 2 open
 *          FLAGGED anomaly scans.
 *   YELLOW any HIGH risk band, OR >= 1 open fix ticket, OR >= 1 open FLAGGED
 *          anomaly scan.
 *   GREEN  otherwise.
 *
 * The composite is recomputed from the CURRENT rows at refresh time (never
 * stale), persisted one-per (owner, scope), audited, and returned with the
 * component breakdown + human-readable evidence strings.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { listRiskScores } from './oracle.js';

export type HealthVerdict = 'GREEN' | 'YELLOW' | 'RED';

export interface HealthSignalRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  scope: string;
  verdict: HealthVerdict;
  components: Record<string, unknown>;
  evidence: string[];
  computed_at: Date;
}

const AIR = {};

function rowOf(r: Record<string, unknown>): HealthSignalRow {
  const components = r.components && typeof r.components === 'object' ? (r.components as Record<string, unknown>) : AIR;
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    scope: String(r.scope),
    verdict: String(r.verdict) as HealthVerdict,
    components,
    evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
    computed_at: new Date(String(r.computed_at)),
  };
}

export async function computeHealthSignal(userId: string, opts: { scope?: string; projectId?: string | null } = {}): Promise<HealthSignalRow> {
  const scope = (opts.scope ?? 'PROJECT').trim();
  if (!scope) throw AppError.badRequest('scope_required', 'scope is required');

  const risks = await listRiskScores(userId);
  const riskBands: Record<string, number> = {};
  for (const r of risks) riskBands[r.risk_band] = (riskBands[r.risk_band] ?? 0) + 1;
  const criticalRisks = riskBands['CRITICAL'] ?? 0;
  const highRisks = riskBands['HIGH'] ?? 0;

  return withTenant<HealthSignalRow>(userId, async (q) => {
    const [fixRows, anomalyRows, replayRows] = await Promise.all([
      q.query<Record<string, unknown>>('SELECT * FROM fix_tickets WHERE owner_id = $1', [userId]).then((r) => r.rows),
      q.query<Record<string, unknown>>('SELECT * FROM anomaly_scans WHERE owner_id = $1', [userId]).then((r) => r.rows),
      q.query<Record<string, unknown>>('SELECT * FROM replay_sessions WHERE owner_id = $1', [userId]).then((r) => r.rows),
    ]);
    const openFixTickets = fixRows.filter((f) => ['OPEN', 'IN_REPRODUCTION', 'FIX_PROPOSED', 'PR_OPENED'].includes(String(f.status))).length;
    const openFlaggedAnomalies = anomalyRows.filter((a) => String(a.status) === 'OPEN' && String(a.verdict) === 'FLAGGED').length;
    const activeReplays = replayRows.filter((r) => String(r.status) === 'ACTIVE').length;

    const evidence: string[] = [];
    if (criticalRisks > 0) evidence.push(`${criticalRisks} CRITICAL risk target(s) — highest break probability`);
    if (highRisks > 0) evidence.push(`${highRisks} HIGH risk target(s) trending toward break`);
    if (openFixTickets >= 3) evidence.push(`${openFixTickets} open fix tickets — escalate`);
    else if (openFixTickets > 0) evidence.push(`${openFixTickets} open fix ticket(s) in the inbox`);
    if (openFlaggedAnomalies >= 2) evidence.push(`${openFlaggedAnomalies} open FLAGGED anomaly scans — code truth is drifting`);
    else if (openFlaggedAnomalies > 0) evidence.push(`${openFlaggedAnomalies} open FLAGGED anomaly scan(s)`);

    let verdict: HealthVerdict = 'GREEN';
    if (criticalRisks > 0 || openFixTickets >= 3 || openFlaggedAnomalies >= 2) verdict = 'RED';
    else if (highRisks > 0 || openFixTickets >= 1 || openFlaggedAnomalies >= 1) verdict = 'YELLOW';
    if (evidence.length === 0) evidence.push('No CRITICAL/HIGH risks, no open fixes, no open flagged anomalies');

    const components = {
      risks: riskBands,
      open_fix_tickets: openFixTickets,
      open_flagged_anomalies: openFlaggedAnomalies,
      active_replays: activeReplays,
    };

    const existing = await q.query<Record<string, unknown>>(
      'SELECT * FROM health_signals WHERE owner_id = $1 AND scope = $2',
      [userId, scope],
    ).then((r) => r.rows);
    if (existing[0]) {
      const id = String(existing[0].id);
      await q.query(
        'UPDATE health_signals SET verdict = $1, components = $2::jsonb, evidence = $3::jsonb, computed_at = now() WHERE id = $4 AND owner_id = $5',
        [verdict, JSON.stringify(components), JSON.stringify(evidence), id, userId],
      );
      await recordAudit({
        action: AuditAction.HEALTH_SIGNAL_REFRESHED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'health_signals',
        resourceId: id,
        detail: { scope, verdict },
      });
      const rows = await q.query<Record<string, unknown>>('SELECT * FROM health_signals WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows);
      return rowOf(rows[0]!);
    }

    const id = newId(PREFIX.HEALTH_SIGNAL);
    await q.query(
      `INSERT INTO health_signals (id, owner_id, project_id, scope, verdict, components, evidence, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,now())`,
      [id, userId, opts.projectId ?? null, scope, verdict, JSON.stringify(components), JSON.stringify(evidence)],
    );
    await recordAudit({
      action: AuditAction.HEALTH_SIGNAL_REFRESHED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'health_signals',
      resourceId: id,
      detail: { scope, verdict },
    });
    const rows = await q.query<Record<string, unknown>>('SELECT * FROM health_signals WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows);
    return rowOf(rows[0]!);
  });
}

export async function getHealthSignal(userId: string, opts: { scope?: string } = {}): Promise<HealthSignalRow | null> {
  const scope = (opts.scope ?? 'PROJECT').trim();
  const rows = await withTenant<Array<Record<string, unknown>>>(userId, (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM health_signals WHERE owner_id = $1 AND scope = $2', [userId, scope])
      .then((r) => r.rows),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}