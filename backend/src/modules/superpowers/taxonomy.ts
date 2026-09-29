/**
 * CodeConClave — Superpowers: SKILL TAXONOMY (Master Feature #58).
 *
 * Every commit, review and correction emits a weight-bearing skill signal.
 * "Who knows the billing system best?" is answered from data, not tribal
 * memory — and review routing follows the signal, never a hunch.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type SkillSource = 'COMMIT' | 'REVIEW' | 'CORRECTION';

export const SKILL_SOURCES: SkillSource[] = ['COMMIT', 'REVIEW', 'CORRECTION'];

export interface SkillSignalRow {
  id: string;
  owner_id: string;
  developer: string;
  skill: string;
  domain: string;
  weight: number;
  source: SkillSource;
  evidence_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SkillSignalRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  developer: String(r.developer),
  skill: String(r.skill),
  domain: String(r.domain ?? 'GENERAL'),
  weight: Number(r.weight ?? 1),
  source: r.source as SkillSource,
  evidence_ref: r.evidence_ref ? String(r.evidence_ref) : null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export interface SkillSignalInput {
  developer: string;
  skill: string;
  domain?: string;
  weight?: number;
  source: SkillSource;
  evidenceRef?: string | null;
}

export async function recordSkillSignal(userId: string, input: SkillSignalInput): Promise<SkillSignalRow> {
  const developer = (input.developer ?? '').trim();
  const skill = (input.skill ?? '').trim();
  const domain = (input.domain ?? 'GENERAL').trim() || 'GENERAL';
  const weight = Math.floor(Number(input.weight ?? 1));
  if (!developer || !skill) throw AppError.badRequest('incomplete_signal', 'developer and skill are required');
  if (!Number.isFinite(weight) || weight < 1) throw AppError.badRequest('invalid_weight', 'skill signal weight must be a positive integer');
  if (!SKILL_SOURCES.includes(input.source)) throw AppError.badRequest('invalid_source', 'source must be COMMIT, REVIEW or CORRECTION');
  const existing = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q
      .query<Record<string, unknown>>(
        'SELECT * FROM skill_signals WHERE owner_id = $1 AND developer = $2 AND skill = $3 AND source = $4',
        [userId, developer, skill, input.source],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (existing) {
    const nextWeight = Number(existing.weight ?? 1) + weight;
    await withTenant(userId, (q) =>
      q.query('UPDATE skill_signals SET weight = $3, domain = $4, evidence_ref = $5, updated_at = now() WHERE id = $1 AND owner_id = $2', [
        String(existing.id),
        userId,
        nextWeight,
        domain,
        input.evidenceRef ?? null,
      ]),
    );
    await recordAudit({
      action: AuditAction.SKILL_SIGNAL_RECORDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'skill_signals',
      resourceId: String(existing.id),
      detail: { developer, skill, source: input.source, weight: nextWeight, updated: true },
    });
    return findSignalById(userId, String(existing.id));
  }
  const id = newId(PREFIX.SKILL_SIGNAL);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO skill_signals (id, owner_id, developer, skill, domain, weight, source, evidence_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, userId, developer, skill, domain, weight, input.source, input.evidenceRef ?? null],
    ),
  );
  await recordAudit({
    action: AuditAction.SKILL_SIGNAL_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'skill_signals',
    resourceId: id,
    detail: { developer, skill, source: input.source, weight, updated: false },
  });
  return findSignalById(userId, id);
}

export async function findSignalById(userId: string, id: string): Promise<SkillSignalRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM skill_signals WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('skill_signal_not_found', 'no skill signal found for that id');
  return rowOf(row);
}

export interface SkillRankingEntry {
  developer: string;
  weight: number;
}

export async function whoKnows(userId: string, skill: string): Promise<{ skill: string; ranking: SkillRankingEntry[] }> {
  const skillName = (skill ?? '').trim();
  if (!skillName) throw AppError.badRequest('missing_skill', 'a skill is required');
  const matching = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM skill_signals WHERE owner_id = $1', [userId]).then((r) => r.rows),
  ))
    .map(rowOf)
    .filter((s) => s.skill.toLowerCase() === skillName.toLowerCase());
  const perDev = new Map<string, number>();
  for (const s of matching) perDev.set(s.developer, (perDev.get(s.developer) ?? 0) + s.weight);
  const ranking = [...perDev.entries()]
    .map(([developer, weight]) => ({ developer, weight }))
    .sort((a, b) => b.weight - a.weight || a.developer.localeCompare(b.developer));
  return { skill: skillName, ranking };
}

export async function routeReview(userId: string, input: { skill: string; domain?: string }): Promise<{
  skill: string;
  recommendation: SkillRankingEntry | null;
  ranking: SkillRankingEntry[];
}> {
  const { skill, ranking } = await whoKnows(userId, input.skill);
  const recommendation = ranking[0] ?? null;
  const domain = (input.domain ?? 'GENERAL').trim() || 'GENERAL';
  await recordAudit({
    action: AuditAction.SKILL_REVIEW_ROUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'skill_signals',
    resourceId: null,
    detail: { skill, domain, recommendation: recommendation?.developer ?? null },
  });
  return { skill, recommendation, ranking };
}

export async function listSkillSignals(userId: string, filter: { developer?: string; skill?: string } = {}): Promise<SkillSignalRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM skill_signals WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(rowOf);
  if (filter.developer) rows = rows.filter((s) => s.developer.toLowerCase() === filter.developer!.toLowerCase());
  if (filter.skill) rows = rows.filter((s) => s.skill.toLowerCase() === filter.skill!.toLowerCase());
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || a.skill.localeCompare(b.skill) || a.developer.localeCompare(b.developer));
}

export async function developerTopSkills(userId: string, developer: string, limit = 5): Promise<Array<{ skill: string; weight: number }>> {
  const signals = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM skill_signals WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(rowOf);
  const perSkill = new Map<string, number>();
  for (const s of signals) {
    if (s.developer.toLowerCase() !== developer.toLowerCase()) continue;
    perSkill.set(s.skill, (perSkill.get(s.skill) ?? 0) + s.weight);
  }
  return [...perSkill.entries()]
    .map(([skill, weight]) => ({ skill, weight }))
    .sort((a, b) => b.weight - a.weight || a.skill.localeCompare(b.skill))
    .slice(0, Math.max(1, limit));
}