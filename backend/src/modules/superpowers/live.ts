/**
 * CodeConClave — Superpowers: LIVE DIFF WATCH (Master Feature #67).
 *
 * While a coworker works, its edits appear live in your editor — like Google
 * Docs for agents. This service is the append-only event log behind the SSE
 * stream:
 *
 *   appendEvent(kind, user, task, ...)  -> coworker runtime records each edit,
 *                                          checkpoint, decision as it happens.
 *   streamEvents(user, task, cursor)    -> the SSE route subscribes; consumers
 *                                          poll from the last cursor (seq) so
 *                                          replay works with Last-Event-ID.
 *   commentOnDiff(user, task, ...)      -> you comment on the live diff; the
 *                                          event is persisted so the coworker
 *                                          picks it up mid-task ("adjusts
 *                                          instead of after").
 *
 * Every event is an immutable, sequentially-numbered row (agent_events.seq).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const AgentEventKind = {
  TASK_CREATED: 'task_created',
  FILE_CHANGED: 'file_changed',
  COMMENT: 'comment',
  CHECKPOINT_CREATED: 'checkpoint_created',
  FIX_REQUESTED: 'fix_requested',
  INTENT_DETECTED: 'intent_detected',
} as const;
export type AgentEventKind = (typeof AgentEventKind)[keyof typeof AgentEventKind];
const EVENT_KINDS = new Set<string>(Object.values(AgentEventKind));

export interface AgentEventInput {
  taskId: string;
  runId?: string | null;
  kind: AgentEventKind;
  path?: string | null;
  patch?: string | null;
  payload?: Record<string, unknown>;
  sourceUid?: string | null;
  projectId?: string | null;
}

export interface AgentEventRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  task_id: string;
  run_id: string | null;
  seq: number;
  kind: AgentEventKind;
  path: string | null;
  patch: string | null;
  payload: Record<string, unknown>;
  source_uid: string | null;
  created_at: Date;
}

function rowOf(r: Record<string, unknown>): AgentEventRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    task_id: String(r.task_id),
    run_id: r.run_id === null ? null : String(r.run_id),
    seq: Number(r.seq),
    kind: String(r.kind) as AgentEventKind,
    path: r.path === null ? null : String(r.path),
    patch: r.patch === null ? null : String(r.patch),
    payload: r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {},
    source_uid: r.source_uid === null ? null : String(r.source_uid),
    created_at: new Date(String(r.created_at)),
  };
}

/** Append an immutable event to the live task timeline. */
export async function appendAgentEvent(userId: string, input: AgentEventInput): Promise<AgentEventRow> {
  const taskId = (input.taskId ?? '').trim();
  if (!taskId) throw AppError.badRequest('task_id_required', 'A task id is required');
  if (!EVENT_KINDS.has(input.kind)) throw AppError.badRequest('invalid_event_kind', `Unknown agent event kind: ${input.kind}`);
  const id = newId(PREFIX.AGENT_EVENT);
  const res = await withTenant(userId, (q) =>
    q.query<{ seq: number }>(
      `INSERT INTO agent_events (id, owner_id, project_id, task_id, run_id, kind, path, patch, payload, source_uid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING seq`,
      [
        id, userId, input.projectId ?? null, taskId, input.runId ?? null,
        input.kind, input.path ?? null, input.patch ?? null,
        JSON.stringify(input.payload ?? {}), input.sourceUid ?? null,
      ],
    ),
  );
  const seq = Number(res.rows[0]!.seq);
  if (input.kind === AgentEventKind.COMMENT || input.kind === AgentEventKind.FIX_REQUESTED) {
    await recordAudit({
      action: AuditAction.AGENT_DIFF_COMMENTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'agent_events',
      resourceId: id,
      detail: { taskId, kind: input.kind, path: input.path ?? null },
    });
  } else if (input.kind === AgentEventKind.FILE_CHANGED) {
    await recordAudit({
      action: AuditAction.AGENT_EVENT_APPENDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'agent_events',
      resourceId: id,
      detail: { taskId, path: input.path ?? null },
    });
  }
  return getAgentEvent(userId, id);
}

export async function getAgentEvent(userId: string, eventId: string): Promise<AgentEventRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM agent_events WHERE id = $1 AND owner_id = $2',
      [eventId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Agent event');
  return rowOf(rows[0]);
}

/** Read the live timeline after an optional cursor (exclusive). `limit` guards
 *  the poll loop; returns [] when nothing new has happened yet. */
export async function streamAgentEvents(
  userId: string,
  taskId: string,
  opts: { afterSeq?: number; limit?: number; since?: Date } = {},
): Promise<AgentEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  let rows: Record<string, unknown>[];
  if (opts.afterSeq !== undefined && opts.afterSeq > 0) {
    rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>(
        'SELECT * FROM agent_events WHERE owner_id = $1 AND task_id = $2 AND seq > $3 ORDER BY seq ASC LIMIT $4',
        [userId, taskId, opts.afterSeq, limit],
      )).rows,
    );
  } else if (opts.since) {
    rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>(
        'SELECT * FROM agent_events WHERE owner_id = $1 AND task_id = $2 AND created_at >= $3 ORDER BY seq ASC LIMIT $4',
        [userId, taskId, opts.since, limit],
      )).rows,
    );
  } else {
    rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>(
        'SELECT * FROM agent_events WHERE owner_id = $1 AND task_id = $2 ORDER BY seq ASC LIMIT $3',
        [userId, taskId, limit],
      )).rows,
    );
  }
  return rows.map(rowOf);
}

/** Comment on the live diff: persisted as a COMMENT event so the coworker
 *  consumes it mid-task. */
export async function commentOnDiff(
  userId: string,
  input: { taskId: string; runId?: string | null; path: string; comment: string; projectId?: string | null },
): Promise<AgentEventRow> {
  const { taskId, path, comment } = input;
  if (!taskId.trim()) throw AppError.badRequest('task_id_required', 'A task id is required');
  if (!path.trim()) throw AppError.badRequest('path_required', 'A file path is required');
  if (!comment.trim()) throw AppError.badRequest('comment_required', 'A comment is required');
  return appendAgentEvent(userId, {
    taskId,
    runId: input.runId ?? null,
    kind: AgentEventKind.COMMENT,
    path: path.trim(),
    patch: null,
    payload: { comment: comment.trim().slice(0, 4000), authored_at: new Date().toISOString() },
    sourceUid: userId,
    projectId: input.projectId ?? null,
  });
}