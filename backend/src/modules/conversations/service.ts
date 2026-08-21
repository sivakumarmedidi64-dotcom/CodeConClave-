/**
 * CodeConClave — conversations module.
 * Conversations (CHAT/COWORK), messages, edit history, reactions, threads,
 * mentions. Ownership: conversations are owner-scoped (project association is
 * metadata); every operation resolves ownership server-side.
 */
import { pool, withTenant, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { requireTeamRole } from '../teams/service.js';
import { AuditAction, NotificationType, TeamRole, type Message, type ChatMessageInput } from '@codeconclave/shared';

/**
 * Phase 17 — SSE Last-Event-ID replay.
 * Returns the assistant/coworker messages persisted AFTER the anchor message
 * (`msg_<messageId>`) in the SAME conversation — the anchor must belong to a
 * conversation owned by the requesting user (tenant-safe without RLS: the
 * JOIN enforces ownership). Malformed ids, unknown anchors, wrong
 * conversations, and non-owner callers replay nothing (fresh stream).
 */
export async function replayMissedMessages(
  userId: string,
  conversationId: string | undefined,
  lastEventId: string,
): Promise<{ id: string; content: string }[]> {
  if (!conversationId || !lastEventId.startsWith('msg_')) return [];
  const anchorId = lastEventId.slice('msg_'.length);
  if (!anchorId) return [];
  const anchor = await queryMany<{ created_at: Date }>(
    `SELECT m.created_at FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND m.conversation_id = $2 AND m.deleted_at IS NULL
       AND c.deleted_at IS NULL AND c.owner_id = $3`,
    [anchorId, conversationId, userId],
  );
  if (anchor.length === 0) return [];
  const rows = await queryMany<{ id: string; content: string }>(
    `SELECT id, content FROM messages
     WHERE conversation_id = $1 AND deleted_at IS NULL AND role IN ('assistant', 'coworker')
       AND created_at > $2
     ORDER BY created_at ASC`,
    [conversationId, anchor[0]!.created_at],
  );
  return rows;
}

export interface ConversationRow {
  id: string;
  project_id: string | null;
  team_id: string | null;
  owner_id: string;
  title: string;
  mode: 'CHAT' | 'COWORK';
  archived: boolean;
  is_favorite: boolean;
  tags: string[];
  sharing: Record<string, unknown>;
  search_metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender: string;
  coworker_type: string | null;
  role: string;
  content: string;
  model_id: string | null;
  provider_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  status: string;
  error_code: string | null;
  edited_at: Date | null;
  edit_count: number;
  thread_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

export function toConversationJson(c: ConversationRow) {
  return {
    id: c.id,
    projectId: c.project_id,
    teamId: c.team_id ?? null,
    title: c.title,
    mode: c.mode,
    archived: c.archived ?? false,
    favorite: c.is_favorite ?? false,
    tags: c.tags ?? [],
    sharing: c.sharing ?? {},
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    deletedAt: c.deleted_at,
  };
}

export async function createConversation(
  userId: string,
  input: { projectId?: string; title?: string; mode?: 'CHAT' | 'COWORK' },
): Promise<ConversationRow> {
  const conversationId = newId(PREFIX.CONVERSATION);
  await withTenant(userId, async (q) => {
    // Validate project access inside the tenant transaction.
    if (input.projectId) {
      const p = await q.query('SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL', [input.projectId]);
      if (!p.rows[0]) throw AppError.notFound('Project');
    }
    const title = input.title ?? 'New conversation';
    await q.query(
      `INSERT INTO conversations (id, project_id, owner_id, title, mode, search_metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        conversationId,
        input.projectId ?? null,
        userId,
        title,
        input.mode ?? 'CHAT',
        JSON.stringify({ title }),
      ],
    );
  });
  await recordAudit({
    action: AuditAction.CONVERSATION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'conversation',
    resourceId: conversationId,
  });
  return (await getConversation(userId, conversationId)) as ConversationRow;
}

export async function getConversation(userId: string, conversationId: string): Promise<ConversationRow> {
  const rows = await queryMany<ConversationRow>(
    `SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL
     AND (owner_id = $2 OR team_id IN (SELECT team_id FROM team_members WHERE user_id = $2 AND status = 'ACTIVE'))`,
    [conversationId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Conversation');
  return rows[0];
}

export async function listConversations(
  userId: string,
  projectId?: string,
  filters: { favorite?: boolean; archived?: boolean } = {},
  includeTeams = false,
): Promise<ConversationRow[]> {
  const params: unknown[] = [userId];
  const clauses: string[] = [
    includeTeams
      ? "(owner_id = $1 OR team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))"
      : 'owner_id = $1',
    'deleted_at IS NULL',
  ];
  if (projectId) {
    params.push(projectId);
    clauses.push('project_id = $2');
  }
  if (filters.favorite !== undefined) {
    params.push(filters.favorite);
    clauses.push(`is_favorite = $${params.length}`);
  }
  if (filters.archived !== undefined) {
    params.push(filters.archived);
    clauses.push(`archived = $${params.length}`);
  }
  return queryMany<ConversationRow>(
    `SELECT * FROM conversations WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    params,
  );
}

export async function updateConversation(
  userId: string,
  conversationId: string,
  input: { title?: string; archived?: boolean; favorite?: boolean; tags?: string[] },
): Promise<ConversationRow> {
  const conversation = await getConversation(userId, conversationId);
  if (input.archived !== undefined && conversation.team_id && conversation.owner_id !== userId) {
    // Team-shared conversations: archive/trash requires a team manager.
    await requireTeamRole(userId, conversation.team_id, [TeamRole.OWNER, TeamRole.ADMIN]);
  }
  const fields: string[] = [];
  const params: unknown[] = [conversationId];
  if (input.title !== undefined) {
    fields.push(`title = $${params.length + 1}`);
    params.push(input.title.slice(0, 200));
  }
  if (input.archived !== undefined) {
    fields.push(`archived = $${params.length + 1}`);
    params.push(input.archived);
  }
  if (input.favorite !== undefined) {
    fields.push(`is_favorite = $${params.length + 1}`);
    params.push(input.favorite);
  }
  if (input.tags !== undefined) {
    fields.push(`tags = $${params.length + 1}`);
    params.push(input.tags);
  }
  if (fields.length) {
    await pool.query(`UPDATE conversations SET ${fields.join(', ')} WHERE id = $1`, params);
  }
  if (input.title !== undefined) {
    await pool.query(
      `UPDATE conversations SET search_metadata = $2::jsonb WHERE id = $1`,
      [conversationId, JSON.stringify({ title: input.title })],
    );
    await recordAudit({
      action: AuditAction.CONVERSATION_RENAMED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'conversation',
      resourceId: conversationId,
    });
  }
  if (input.archived !== undefined) {
    await recordAudit({
      action: input.archived ? AuditAction.CONVERSATION_ARCHIVED : AuditAction.CONVERSATION_RESTORED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'conversation',
      resourceId: conversationId,
    });
  }
  if (input.favorite !== undefined) {
    await recordAudit({
      action: AuditAction.CONVERSATION_FAVORITED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'conversation',
      resourceId: conversationId,
      detail: { favorite: input.favorite },
    });
  }
  return getConversation(userId, conversationId);
}

export async function renameConversation(userId: string, conversationId: string, title: string): Promise<ConversationRow> {
  return updateConversation(userId, conversationId, { title });
}

export async function archiveConversation(userId: string, conversationId: string, archived: boolean): Promise<ConversationRow> {
  return updateConversation(userId, conversationId, { archived });
}

export async function setConversationSharing(
  userId: string,
  conversationId: string,
  sharing: Record<string, unknown>,
): Promise<ConversationRow> {
  await getConversation(userId, conversationId);
  await pool.query('UPDATE conversations SET sharing = $2::jsonb WHERE id = $1', [
    conversationId,
    JSON.stringify(sharing),
  ]);
  return getConversation(userId, conversationId);
}

export async function softDeleteConversation(userId: string, conversationId: string): Promise<void> {
  const conversation = await getConversation(userId, conversationId);
  if (conversation.team_id && conversation.owner_id !== userId) {
    await requireTeamRole(userId, conversation.team_id, [TeamRole.OWNER, TeamRole.ADMIN]);
  }
  await pool.query('UPDATE conversations SET deleted_at = now() WHERE id = $1', [conversationId]);
  await recordAudit({
    action: AuditAction.CONVERSATION_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'conversation',
    resourceId: conversationId,
    detail: { soft: true },
  });
}

export async function restoreConversation(userId: string, conversationId: string): Promise<ConversationRow> {
  const result = await pool.query(
    'UPDATE conversations SET deleted_at = NULL WHERE id = $1 AND owner_id = $2 RETURNING *',
    [conversationId, userId],
  );
  if (!result.rows[0]) throw AppError.notFound('Conversation');
  await recordAudit({
    action: AuditAction.CONVERSATION_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'conversation',
    resourceId: conversationId,
  });
  return result.rows[0] as ConversationRow;
}

export async function trashConversations(userId: string): Promise<ConversationRow[]> {
  return queryMany<ConversationRow>(
    `SELECT * FROM conversations WHERE owner_id = $1 AND deleted_at IS NOT NULL
     AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC`,
    [userId],
  );
}

// ---------------------------------------------------------------- messages

export async function insertMessage(
  userId: string,
  input: {
    conversationId: string;
    sender: string;
    coworkerType?: string | null;
    role: 'user' | 'assistant' | 'system';
    content: string;
    modelId?: string | null;
    providerId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number | null;
    status?: string;
    errorCode?: string | null;
  },
): Promise<MessageRow> {
  await getConversation(userId, input.conversationId);
  const id = newId(PREFIX.MESSAGE);
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, sender, coworker_type, role, content, model_id, provider_id,
        input_tokens, output_tokens, latency_ms, status, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      input.conversationId,
      input.sender,
      input.coworkerType ?? null,
      input.role,
      input.content,
      input.modelId ?? null,
      input.providerId ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.latencyMs ?? null,
      input.status ?? 'COMPLETED',
      input.errorCode ?? null,
    ],
  );
  await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [input.conversationId]);
  const rows = await queryMany<MessageRow>('SELECT * FROM messages WHERE id = $1', [id]);
  return rows[0]!;
}

export async function updateMessageStatus(
  messageId: string,
  patch: { status?: string; content?: string; inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number | null; errorCode?: string | null; modelId?: string | null; providerId?: string | null },
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [messageId];
  const set = (col: string, value: unknown, sql?: string) => {
    fields.push(sql ?? `${col} = $${params.length + 1}`);
    if (!sql) params.push(value);
  };
  if (patch.status) set('status', patch.status);
  if (patch.content !== undefined) set('content', patch.content);
  if (patch.modelId !== undefined) set('model_id', patch.modelId);
  if (patch.providerId !== undefined) set('provider_id', patch.providerId);
  if (patch.inputTokens !== undefined) set('input_tokens', patch.inputTokens);
  if (patch.outputTokens !== undefined) set('output_tokens', patch.outputTokens);
  if (patch.latencyMs !== undefined) set('latency_ms', patch.latencyMs);
  if (patch.errorCode !== undefined) set('error_code', patch.errorCode);
  if (!fields.length) return;
  await pool.query(`UPDATE messages SET ${fields.join(', ')} WHERE id = $1`, params);
}

export async function listMessages(userId: string, conversationId: string, before?: Date, limit = 100): Promise<MessageRow[]> {
  await getConversation(userId, conversationId);
  const params: unknown[] = [conversationId, Math.min(limit, 500)];
  let beforeClause = '';
  if (before) {
    params.push(before);
    beforeClause = 'AND created_at < $3';
  }
  return queryMany<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ${beforeClause}
     ORDER BY created_at DESC, seq DESC LIMIT $2`,
    params,
  );
}

/** Edit message content with an immutable edit-history snapshot (owner only). */
export async function editMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
): Promise<MessageRow> {
  await getConversation(userId, conversationId);
  const result = await pool.query(
    'SELECT content FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
    [messageId, conversationId],
  );
  const prev = result.rows[0] as { content: string } | undefined;
  if (!prev) throw AppError.notFound('Message');
  await pool.query(
    `INSERT INTO message_edits (id, message_id, content, edited_by) VALUES ($1,$2,$3,$4)`,
    [newId(PREFIX.MESSAGE_EDIT), messageId, prev.content, userId],
  );
  await pool.query(
    `UPDATE messages SET content = $2, edited_at = now(), edit_count = edit_count + 1 WHERE id = $1`,
    [messageId, content],
  );
  await recordAudit({
    action: AuditAction.MESSAGE_EDITED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'message',
    resourceId: messageId,
  });
  const rows = await queryMany<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId]);
  return rows[0]!;
}

export async function softDeleteMessage(userId: string, conversationId: string, messageId: string): Promise<void> {
  await getConversation(userId, conversationId);
  const result = await pool.query(
    'UPDATE messages SET deleted_at = now() WHERE id = $1 AND conversation_id = $2 RETURNING id',
    [messageId, conversationId],
  );
  if (!result.rows[0]) throw AppError.notFound('Message');
}

// ---------------------------------------------------------------- threads

export async function createThread(
  userId: string,
  conversationId: string,
  parentMessageId: string,
  title: string,
): Promise<{ id: string; conversation_id: string; parent_message_id: string; title: string; created_at: Date }> {
  await getConversation(userId, conversationId);
  const msg = await pool.query(
    'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
    [parentMessageId, conversationId],
  );
  if (!msg.rows[0]) throw AppError.notFound('Message');
  const threadId = newId(PREFIX.THREAD);
  await pool.query(
    `INSERT INTO threads (id, conversation_id, parent_message_id, title, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [threadId, conversationId, parentMessageId, title.slice(0, 200), userId],
  );
  await recordAudit({
    action: AuditAction.THREAD_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'thread',
    resourceId: threadId,
  });
  const rows = await queryMany<{ id: string; conversation_id: string; parent_message_id: string; title: string; created_at: Date }>(
    'SELECT id, conversation_id, parent_message_id, title, created_at FROM threads WHERE id = $1',
    [threadId],
  );
  return rows[0]!;
}

export async function listThreads(userId: string, conversationId: string): Promise<unknown[]> {
  await getConversation(userId, conversationId);
  return queryMany(
    `SELECT t.id, t.parent_message_id, t.title, t.created_at, u.display_name AS created_by_name
     FROM threads t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.conversation_id = $1 AND t.deleted_at IS NULL
     ORDER BY t.created_at ASC`,
    [conversationId],
  );
}

// ---------------------------------------------------------------- mentions

export async function addMention(
  userId: string,
  conversationId: string,
  messageId: string,
  targetUserId: string,
): Promise<void> {
  await getConversation(userId, conversationId);
  const msg = await pool.query(
    'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
    [messageId, conversationId],
  );
  if (!msg.rows[0]) throw AppError.notFound('Message');
  await pool.query(
    `INSERT INTO mentions (id, message_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [newId(PREFIX.MENTION), messageId, targetUserId],
  );
  await recordAudit({
    action: AuditAction.MENTION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'mention',
    resourceId: messageId,
    detail: { targetUserId },
  });
  if (targetUserId !== userId) {
    try {
      await notify(targetUserId, NotificationType.MENTION, 'You were mentioned', {
        body: `In conversation ${conversationId}`,
        resourceType: 'conversation',
        resourceId: conversationId,
        metadata: { messageId, actorUserId: userId },
      });
    } catch {
      /* best-effort */
    }
  }
}

export async function listMentionsForUser(userId: string, limit = 50): Promise<unknown[]> {
  return queryMany(
    `SELECT m.id, m.message_id, m.created_at, c.id AS conversation_id, c.title AS conversation_title
     FROM mentions m
     JOIN messages msg ON msg.id = m.message_id
     JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.user_id = $1 AND c.owner_id = $1 AND msg.deleted_at IS NULL AND c.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 200)],
  );
}

// ---------------------------------------------------------------- reactions / search

export async function addReaction(userId: string, conversationId: string, messageId: string, emoji: string): Promise<void> {
  await getConversation(userId, conversationId);
  await pool.query(
    `INSERT INTO reactions (id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4)
     ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
    [newId(PREFIX.MESSAGE), messageId, userId, emoji.slice(0, 16)],
  );
}

export async function removeReaction(userId: string, conversationId: string, messageId: string, emoji: string): Promise<void> {
  await getConversation(userId, conversationId);
  await pool.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, userId, emoji]);
}

export async function listReactions(conversationId: string): Promise<unknown[]> {
  return queryMany(
    `SELECT r.message_id, r.emoji, r.user_id, u.display_name
     FROM reactions r JOIN messages m ON m.id = r.message_id
     JOIN users u ON u.id = r.user_id
     WHERE m.conversation_id = $1`,
    [conversationId],
  );
}

export async function searchConversations(userId: string, query: string): Promise<ConversationRow[]> {
  return queryMany<ConversationRow>(
    `SELECT DISTINCT c.* FROM conversations c
     JOIN messages m ON m.conversation_id = c.id
     WHERE (c.owner_id = $1 OR c.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))
       AND c.deleted_at IS NULL AND m.deleted_at IS NULL
       AND (to_tsvector('simple', coalesce(m.content,'')) @@ plainto_tsquery('simple', $2)
            OR m.content ILIKE $3)
     ORDER BY c.updated_at DESC LIMIT 20`,
    [userId, query, `%${query}%`],
  );
}

export function toMessageJson(m: MessageRow): Message {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    sender: m.sender as Message['sender'],
    coworkerType: (m.coworker_type as Message['coworkerType']) ?? null,
    role: m.role as Message['role'],
    content: m.content,
    modelId: m.model_id,
    providerId: (m.provider_id as Message['providerId']) ?? null,
    inputTokens: m.input_tokens,
    outputTokens: m.output_tokens,
    latencyMs: m.latency_ms,
    status: m.status as Message['status'],
    errorCode: m.error_code,
    editedAt: m.edited_at ?? null,
    editCount: m.edit_count ?? 0,
    threadId: m.thread_id ?? null,
    createdAt: m.created_at,
  };
}

export type { ChatMessageInput };