/**
 * CodeConClave — Superpowers: VOICE TO TASK (Master Feature #73).
 *
 * Dictate a task from your phone; it enters the exact same queue as a typed
 * instruction. Build while walking.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface VoiceTaskRow {
  id: string;
  owner_id: string;
  script: string;
  title: string;
  body: string;
  source: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): VoiceTaskRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  script: String(r.script),
  title: String(r.title),
  body: String(r.body),
  source: String(r.source),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** Strip the filler words hallway chatter produces. */
export function cleanTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(um|uh|er|hm|kinda|sorta|basically)\b/g, ' ')
    .replace(/\byou know\b/gi, ' ')
    .replace(/\blike\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function dictateTask(userId: string, input: { script: string; source?: string }): Promise<VoiceTaskRow> {
  if (!input.script || typeof input.script !== 'string') throw AppError.badRequest('nothing_recorded', 'nothing was recorded — dictate something first');
  const body = cleanTranscript(input.script);
  const title = body.split(' ').slice(0, 4).join(' ') || 'untitled dictate';
  const source = input.source ?? 'voice';
  const id = newId(PREFIX.VOICE_TASK);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO voice_tasks (id, owner_id, script, title, body, source, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.script, title, body, source, 'QUEUED'],
  ));
  await recordAudit({
    action: AuditAction.VOICE_TASK_QUEUED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'voice_tasks',
    resourceId: id,
    detail: { title, source },
  });
  return getVoiceTask(userId, id);
}

/** Pulled off the queue and into execution, same as a typed instruction. */
export async function startVoiceTask(userId: string, id: string): Promise<VoiceTaskRow> {
  const task = await getVoiceTask(userId, id);
  if (task.status !== 'QUEUED') throw AppError.badRequest('voice_task_already_started', 'that dictate already started — it is past the queue');
  await withTenant(userId, (q) => q.query('UPDATE voice_tasks SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'STARTED', userId]));
  await recordAudit({
    action: AuditAction.VOICE_TASK_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'voice_tasks',
    resourceId: id,
    detail: { title: task.title },
  });
  return getVoiceTask(userId, id);
}

export async function getVoiceTask(userId: string, id: string): Promise<VoiceTaskRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM voice_tasks WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('voice_task_not_found', 'no voice task found for that id');
  return rowOf(row);
}

export async function listVoiceTasks(userId: string): Promise<VoiceTaskRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM voice_tasks WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function voiceTaskReport(userId: string): Promise<{ total: number; queued: number; started: number; sources: number }> {
  const tasks = await listVoiceTasks(userId);
  return {
    total: tasks.length,
    queued: tasks.filter((t) => t.status === 'QUEUED').length,
    started: tasks.filter((t) => t.status === 'STARTED').length,
    sources: new Set(tasks.map((t) => t.source)).size,
  };
}