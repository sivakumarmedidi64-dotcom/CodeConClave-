/**
 * CodeConClave — Superpowers: COWORK REPLAY (Master Feature #163).
 *
 * Every agent session is a replayable, forkable timeline.
 *
 *   CREATE  pin a task at its current event seq → a replay session.
 *   LIST    your sessions, newest first.
 *   FORK    copy the copied event log of that task into a NEW task (the fork
 *           branch) and pin a new session on it — teammates continue from the
 *           exact same trace without touching the original history.
 *   ARCHIVE  close a session you no longer need.
 *
 * Replay is built on the same append-only agent_events log that powers Live
 * Diff Watch (#67), so a replay is always the REAL trace — nothing replayed
 * is reconstructed. All rows are owner-scoped and audited.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type ReplayStatus = 'ACTIVE' | 'ARCHIVED';

export interface ReplaySessionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  task_id: string;
  base_seq: number;
  status: ReplayStatus;
  note: string | null;
  forked_from_task: string | null;
  forked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowOf(r: Record<string, unknown>): ReplaySessionRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    task_id: String(r.task_id),
    base_seq: Number(r.base_seq),
    status: String(r.status) as ReplayStatus,
    note: r.note === null ? null : String(r.note),
    forked_from_task: r.forked_from_task === null ? null : String(r.forked_from_task),
    forked_at: r.forked_at ? new Date(String(r.forked_at)) : null,
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

async function latestTaskSeq(userId: string, taskId: string): Promise<number> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM agent_events WHERE owner_id = $1 AND task_id = $2',
      [userId, taskId],
    )).rows,
  );
  return rows.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
}

async function findByIdAndOwner(userId: string, sessionId: string): Promise<ReplaySessionRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM replay_sessions WHERE id = $1 AND owner_id = $2',
      [sessionId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Replay session');
  return rowOf(rows[0]);
}

export async function createReplaySession(
  userId: string,
  input: { taskId: string; note?: string | null; projectId?: string | null },
): Promise<ReplaySessionRow> {
  const taskId = (input.taskId ?? '').trim();
  if (!taskId) throw AppError.badRequest('task_id_required', 'taskId is required');
  const baseSeq = await latestTaskSeq(userId, taskId);
  const id = newId(PREFIX.REPLAY_SESSION);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO replay_sessions (id, owner_id, project_id, task_id, base_seq, status, note)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
      [id, userId, input.projectId ?? null, taskId, baseSeq, input.note ?? null],
    ),
  );
  await recordAudit({
    action: AuditAction.REPLAY_SESSION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'replay_sessions',
    resourceId: id,
    detail: { taskId, baseSeq },
  });
  return findByIdAndOwner(userId, id);
}

export async function listReplaySessions(userId: string): Promise<ReplaySessionRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM replay_sessions WHERE owner_id = $1', [userId])).rows,
  );
  return rows.map(rowOf).sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

export async function getReplaySession(userId: string, sessionId: string): Promise<ReplaySessionRow> {
  return findByIdAndOwner(userId, sessionId);
}

export async function archiveReplaySession(userId: string, sessionId: string, note?: string | null): Promise<ReplaySessionRow> {
  const session = await findByIdAndOwner(userId, sessionId);
  if (session.status !== 'ARCHIVED') {
    await withTenant(userId, (q) =>
      q.query(
        "UPDATE replay_sessions SET status = 'ARCHIVED', updated_at = now() WHERE id = $1 AND owner_id = $2",
        [sessionId, userId],
      ),
    );
  }
  if (note != null) {
    await withTenant(userId, (q) =>
      q.query('UPDATE replay_sessions SET note = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', [note, sessionId, userId]),
    );
  }
  if (session.status === 'ARCHIVED' && note == null) return session;
  await recordAudit({
    action: AuditAction.REPLAY_SESSION_ARCHIVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'replay_sessions',
    resourceId: sessionId,
    detail: { taskId: session.task_id },
  });
  return findByIdAndOwner(userId, sessionId);
}

/**
 * Fork a session: copy the source task's full event log into a brand-new task
 * and pin a new replay session on it. The forked branch is byte-identical to
 * the original trace (same kinds, patches, payloads, seq order) so the fork
 * continues from the exact moment, never from a reconstruction.
 */
export async function forkReplaySession(userId: string, sessionId: string): Promise<ReplaySessionRow> {
  const source = await findByIdAndOwner(userId, sessionId);
  if (source.status === 'ARCHIVED') throw AppError.conflict('replay_fork_archived', 'cannot fork an archived replay session');

  const events = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM agent_events WHERE owner_id = $1 AND task_id = $2',
      [userId, source.task_id],
    )).rows,
  );
  events.sort((a, b) => Number(a.seq) - Number(b.seq));

  const forkTaskId = newId(PREFIX.TASK);
  const newSessionId = newId(PREFIX.REPLAY_SESSION);
  const originals = (source.forked_from_task ? `${source.forked_from_task} -> ` : '') + source.task_id;

  for (const ev of events) {
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO agent_events (id, owner_id, project_id, task_id, run_id, seq, kind, path, patch, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          newId(PREFIX.AGENT_EVENT), userId,
          ev.project_id === null ? null : String(ev.project_id),
          forkTaskId,
          ev.run_id === null ? null : String(ev.run_id),
          Number(ev.seq),
          String(ev.kind),
          ev.path === null ? null : String(ev.path),
          ev.patch === null ? null : String(ev.patch),
          JSON.stringify((ev.payload as Record<string, unknown>) ?? {}),
        ],
      ),
    );
  }

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO replay_sessions (id, owner_id, project_id, task_id, base_seq, status, note, forked_from_task, forked_at)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,now())`,
      [newSessionId, userId, source.project_id, forkTaskId, events.length, `Fork of ${originals} (${events.length} events copied)`, source.task_id],
    ),
  );
  await recordAudit({
    action: AuditAction.REPLAY_SESSION_FORKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'replay_sessions',
    resourceId: newSessionId,
    detail: { sourceSessionId: sessionId, sourceTaskId: source.task_id, forkTaskId, eventsCopied: events.length },
  });
  return findByIdAndOwner(userId, newSessionId);
}