/**
 * CodeConClave — Superpowers: PAIRING SCHEDULER (Master Feature #139).
 *
 * Automatically pairs senior and junior developers on complex tasks, so
 * knowledge transfer and unblocking happen at the same time — mentorship
 * becomes systematic instead of accidental.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type TaskComplexity = 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'CRITICAL';
export type DevLevel = 'JUNIOR' | 'MID' | 'SENIOR';
export type PairingStatus = 'SCHEDULED' | 'ACCEPTED' | 'COMPLETED';

export interface PairingScheduleRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  task: string;
  complexity: TaskComplexity;
  senior: string;
  junior: string;
  pairing_reason: { rationale: string; knowledge_gap: string };
  status: PairingStatus;
  created_at: Date;
  updated_at: Date;
}

const COMPLEX_TASKS: TaskComplexity[] = ['COMPLEX', 'CRITICAL'];
const LEVEL_RANK: Record<DevLevel, number> = { JUNIOR: 0, MID: 1, SENIOR: 2 };

export interface TeamMember {
  name: string;
  level: DevLevel;
}

const rowOf = (r: Record<string, unknown>): PairingScheduleRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  task: String(r.task),
  complexity: r.complexity as TaskComplexity,
  senior: String(r.senior),
  junior: String(r.junior),
  pairing_reason: (r.pairing_reason ?? {}) as PairingScheduleRow['pairing_reason'],
  status: (r.status ?? 'SCHEDULED') as PairingStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export function pickPair(members: TeamMember[]): { senior: string; junior: string } | null {
  const valid = members.filter((m) => m.name && typeof m.name === 'string' && m.name.trim() !== '');
  if (valid.length < 2) return null;
  const sorted = [...valid].sort((a, b) => a.name.localeCompare(b.name));
  const senior = sorted.reduce((best, m) => (LEVEL_RANK[m.level] > LEVEL_RANK[best.level] ? m : best));
  const junior = sorted.reduce((best, m) => (LEVEL_RANK[m.level] < LEVEL_RANK[best.level] ? m : best));
  if (senior.name === junior.name || LEVEL_RANK[senior.level] <= LEVEL_RANK[junior.level]) return null;
  return { senior: senior.name, junior: junior.name };
}

export async function schedulePairing(
  userId: string,
  input: { projectId?: string | null; task: string; complexity: TaskComplexity; team: TeamMember[] },
): Promise<PairingScheduleRow> {
  if (!input.task || typeof input.task !== 'string') throw AppError.badRequest('invalid_task', 'a task description is required');
  if (!COMPLEX_TASKS.includes(input.complexity)) {
    throw AppError.badRequest('not_complex_task', `pairing is reserved for ${COMPLEX_TASKS.join('/')} tasks`);
  }
  const team = Array.isArray(input.team) ? input.team : [];
  const pair = pickPair(team);
  if (!pair) throw AppError.badRequest('no_suitable_pair', 'need at least one senior and one junior developer to pair');
  const seniorLevel = team.find((m) => m.name === pair.senior)?.level ?? 'MID';
  const juniorLevel = team.find((m) => m.name === pair.junior)?.level ?? 'MID';
  const pairingReason = {
    rationale: `paired ${pair.senior} (${seniorLevel}) with ${pair.junior} (${juniorLevel}) for a ${input.complexity} task: ${input.task}`,
    knowledge_gap: `${pair.junior} gains ${input.complexity.toLowerCase()} task exposure while ${pair.senior} validates the approach live`,
  };
  const id = newId(PREFIX.PAIRING_SCHEDULE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO pairing_schedules (id, owner_id, project_id, task, complexity, senior, junior, pairing_reason, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.projectId ?? null, input.task, input.complexity, pair.senior, pair.junior, pairingReason, 'SCHEDULED'],
  ));
  await recordAudit({
    action: AuditAction.PAIRING_SCHEDULED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pairing_schedules',
    resourceId: id,
    detail: { task: input.task, senior: pair.senior, junior: pair.junior },
  });
  return getPairingSchedule(userId, id);
}

export async function getPairingSchedule(userId: string, id: string): Promise<PairingScheduleRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pairing_schedules WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('pairing_schedule_not_found', 'no pairing schedule found for that id');
  return rowOf(row);
}

export async function acceptPairing(userId: string, id: string): Promise<PairingScheduleRow> {
  const pairing = await getPairingSchedule(userId, id);
  if (pairing.status === 'ACCEPTED' || pairing.status === 'COMPLETED') return pairing;
  await withTenant(userId, (q) => q.query('UPDATE pairing_schedules SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'ACCEPTED']));
  await recordAudit({
    action: AuditAction.PAIRING_ACCEPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pairing_schedules',
    resourceId: id,
    detail: { task: pairing.task },
  });
  return getPairingSchedule(userId, id);
}

export async function completePairing(userId: string, id: string): Promise<PairingScheduleRow> {
  const pairing = await getPairingSchedule(userId, id);
  if (pairing.status === 'COMPLETED') return pairing;
  await withTenant(userId, (q) => q.query('UPDATE pairing_schedules SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'COMPLETED']));
  await recordAudit({
    action: AuditAction.PAIRING_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pairing_schedules',
    resourceId: id,
    detail: { task: pairing.task },
  });
  return getPairingSchedule(userId, id);
}

export async function listPairingSchedules(userId: string, filter: { status?: PairingStatus } = {}): Promise<PairingScheduleRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pairing_schedules WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.sort((a, b) => a.status.localeCompare(b.status) || b.created_at.getTime() - a.created_at.getTime());
}

export async function pairingReport(userId: string): Promise<{
  total: number;
  scheduled: number;
  accepted: number;
  completed: number;
}> {
  const rows = await listPairingSchedules(userId);
  return {
    total: rows.length,
    scheduled: rows.filter((r) => r.status === 'SCHEDULED').length,
    accepted: rows.filter((r) => r.status === 'ACCEPTED').length,
    completed: rows.filter((r) => r.status === 'COMPLETED').length,
  };
}