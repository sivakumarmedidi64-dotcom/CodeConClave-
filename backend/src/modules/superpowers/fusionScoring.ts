/**
 * CodeConClave — Superpowers: HUMAN-AI FUSION SCORING (Master Feature #57).
 *
 * Continuously measures and improves the human+AI system's combined output.
 * Tracks where humans add value, where agents do, and how the mix evolves —
 * shown in numbers, so you see why the partnership is 10x and where to push.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FusionScoreRow {
  id: string;
  owner_id: string;
  window: string;
  human_points: number;
  agent_points: number;
  total: number;
  human_share: number;
  label: string;
  verdict: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): FusionScoreRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  window: String(r.window),
  human_points: Number(r.human_points),
  agent_points: Number(r.agent_points),
  total: Number(r.total),
  human_share: Number(r.human_share),
  label: String(r.label),
  verdict: String(r.verdict),
  created_at: new Date(r.created_at as string),
});

/** The mix: who added the value this window, and where to push next. */
export function fusionMix(humanPoints: number, agentPoints: number): { total: number; human_share: number; label: string; verdict: string } {
  const total = humanPoints + agentPoints;
  const humanShare = total > 0 ? Math.round((humanPoints / total) * 100) : 0;
  const label = humanShare > 66 ? 'human-led' : humanShare < 34 ? 'agent-led' : 'balanced';
  const verdict =
    humanShare >= 34 && humanShare <= 66 && humanPoints >= 10 && agentPoints >= 10
      ? '10x compound active'
      : humanShare > 66
        ? 'push toward agents next'
        : 'push toward humans next';
  return { total, human_share: humanShare, label, verdict };
}

export async function recordFusionSample(userId: string, input: { window: string; human_points: number; agent_points: number }): Promise<FusionScoreRow> {
  if (!input.window || typeof input.window !== 'string') throw AppError.badRequest('invalid_window', 'a window label is required');
  if (typeof input.human_points !== 'number' || input.human_points < 0) throw AppError.badRequest('invalid_points', 'human points must be non-negative');
  if (typeof input.agent_points !== 'number' || input.agent_points < 0) throw AppError.badRequest('invalid_points', 'agent points must be non-negative');
  const mix = fusionMix(input.human_points, input.agent_points);
  const id = newId(PREFIX.FUSION_SAMPLE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO fusion_scores (id, owner_id, "window", human_points, agent_points, total, human_share, label, verdict) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.window, input.human_points, input.agent_points, mix.total, mix.human_share, mix.label, mix.verdict],
  ));
  await recordAudit({
    action: AuditAction.FUSION_SCORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'fusion_scores',
    resourceId: id,
    detail: { window: input.window, human_share: mix.human_share, label: mix.label },
  });
  return getFusionSample(userId, id);
}

export async function fusionTrend(userId: string): Promise<{ samples: number; avg_human_share: number; direction: string; last_label: string }> {
  const samples = await listFusionSamples(userId);
  const avg = samples.length ? Math.round(samples.reduce((s, x) => s + x.human_share, 0) / samples.length) : 0;
  const delta = samples.length > 1 ? samples[0]!.human_share - samples[samples.length - 1]!.human_share : 0;
  const direction = delta > 0 ? 'more human-led' : delta < 0 ? 'more agent-led' : 'stable';
  return { samples: samples.length, avg_human_share: avg, direction, last_label: samples[0]?.label ?? null as unknown as string };
}

export async function getFusionSample(userId: string, id: string): Promise<FusionScoreRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM fusion_scores WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('fusion_sample_not_found', 'no fusion sample found for that id');
  return rowOf(row);
}

export async function listFusionSamples(userId: string): Promise<FusionScoreRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM fusion_scores WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function fusionReport(userId: string): Promise<{ samples: number; avg_human_share: number; balanced_windows: number }> {
  const samples = await listFusionSamples(userId);
  return {
    samples: samples.length,
    avg_human_share: samples.length ? Math.round(samples.reduce((s, x) => s + x.human_share, 0) / samples.length) : 0,
    balanced_windows: samples.filter((s) => s.label === 'balanced').length,
  };
}