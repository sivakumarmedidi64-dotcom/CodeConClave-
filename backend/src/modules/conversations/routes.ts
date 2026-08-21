/**
 * CodeConClave — conversations + chat routes.
 */
import { Router } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { chatMessageSchema, conversationUpdateSchema, messageEditSchema, threadCreateSchema, mentionCreateSchema } from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import {
  addMention,
  addReaction,
  archiveConversation,
  createConversation,
  createThread,
  editMessage,
  getConversation,
  listConversations,
  listMentionsForUser,
  listMessages,
  listReactions,
  listThreads,
  removeReaction,
  renameConversation,
  restoreConversation,
  searchConversations,
  setConversationSharing,
  softDeleteConversation,
  softDeleteMessage,
  toConversationJson,
  toMessageJson,
  trashConversations,
  updateConversation,
  replayMissedMessages,
} from './service.js';
import { sendChatMessage, type ChatStreamEvents } from './chat.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { chatLimit } from '../../middleware/rate-limit.js';
import { AppError } from '../../shared/errors.js';
import { getUserById } from '../auth/service.js';
import { env } from '../../config/env.js';

/**
 * Phase 17 — Last-Event-ID replay for the chat SSE stream.
 * `replayMissedMessages` lives in service.ts (implemented here's contract):
 * the client confirms receipt via the `id: msg_<messageId>` line on `done`;
 * a follow-up request for the SAME conversation carrying that id gets the
 * assistant messages persisted after it replayed as `delta` frames (each with
 * its own `id:`) before the live stream — the client dedupes by id, so
 * nothing renders twice and nothing missed is lost. Unknown anchors, wrong
 * conversations, and malformed ids replay nothing (fresh stream).
 */

export const conversationRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const filters: { favorite?: boolean; archived?: boolean } = {};
      if (req.query.favorite === '1' || req.query.favorite === 'true') filters.favorite = true;
      if (req.query.archived === '1' || req.query.archived === 'true') filters.archived = true;
      const conversations = await listConversations(req.ctx.user!.id, projectId, filters);
      res.json(jsonResult({ conversations: conversations.map(toConversationJson) }));
    }),
  );

  router.get(
    '/search',
    asyncRoute(async (req, res) => {
      const q = String(req.query.q ?? '');
      if (!q.trim()) res.json(jsonResult({ conversations: [] }));
      else res.json(jsonResult({ conversations: (await searchConversations(req.ctx.user!.id, q)).map(toConversationJson) }));
    }),
  );

  router.get(
    '/trash',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ conversations: (await trashConversations(req.ctx.user!.id)).map(toConversationJson) })),
    ),
  );

  router.get(
    '/mentions',
    asyncRoute(async (req, res) => res.json(jsonResult({ mentions: await listMentionsForUser(req.ctx.user!.id) }))),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const conversation = await createConversation(req.ctx.user!.id, {
        projectId: req.body.projectId ? String(req.body.projectId) : undefined,
        title: req.body.title ? String(req.body.title) : undefined,
        mode: req.body.mode === 'COWORK' ? 'COWORK' : 'CHAT',
      });
      res.status(201).json(jsonResult({ conversation: toConversationJson(conversation) }));
    }),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ conversation: toConversationJson(await getConversation(req.ctx.user!.id, req.params.id!)) }));
    }),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const input = conversationUpdateSchema.parse(req.body);
      if (Object.keys(input).length === 0) {
        throw AppError.badRequest('empty_update', 'Nothing to update');
      }
      res.json(jsonResult({ conversation: toConversationJson(await updateConversation(req.ctx.user!.id, req.params.id!, input)) }));
    }),
  );

  router.post(
    '/:id/archive',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ conversation: toConversationJson(await archiveConversation(req.ctx.user!.id, req.params.id!, true)) }));
    }),
  );

  router.post(
    '/:id/unarchive',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ conversation: toConversationJson(await archiveConversation(req.ctx.user!.id, req.params.id!, false)) }));
    }),
  );

  router.put(
    '/:id/sharing',
    asyncRoute(async (req, res) => {
      const sharing = (req.body.sharing ?? {}) as Record<string, unknown>;
      if (typeof sharing !== 'object' || Array.isArray(sharing)) {
        throw AppError.badRequest('invalid_sharing', 'sharing must be an object');
      }
      res.json(jsonResult({ conversation: toConversationJson(await setConversationSharing(req.ctx.user!.id, req.params.id!, sharing)) }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await softDeleteConversation(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/restore',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ conversation: toConversationJson(await restoreConversation(req.ctx.user!.id, req.params.id!)) }));
    }),
  );

  router.get(
    '/:id/threads',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ threads: await listThreads(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/threads',
    asyncRoute(async (req, res) => {
      const input = threadCreateSchema.parse(req.body);
      const thread = await createThread(req.ctx.user!.id, req.params.id!, input.parentMessageId, input.title);
      res.status(201).json(jsonResult({ thread }));
    }),
  );

  router.get(
    '/:id/messages',
    asyncRoute(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const rows = await listMessages(req.ctx.user!.id, req.params.id!, undefined, limit);
      res.json(jsonResult({ messages: rows.reverse().map(toMessageJson) }));
    }),
  );

  router.patch(
    '/:id/messages/:messageId',
    asyncRoute(async (req, res) => {
      const input = messageEditSchema.parse(req.body);
      res.json(jsonResult({ message: toMessageJson(await editMessage(req.ctx.user!.id, req.params.id!, req.params.messageId!, input.content)) }));
    }),
  );

  router.post(
    '/:id/messages/:messageId/mention',
    asyncRoute(async (req, res) => {
      const input = mentionCreateSchema.parse(req.body);
      await addMention(req.ctx.user!.id, req.params.id!, req.params.messageId!, input.userId);
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/messages/:messageId/react',
    asyncRoute(async (req, res) => {
      const emoji = String(req.body.emoji ?? '').trim();
      if (!emoji) throw AppError.badRequest('emoji_required', 'emoji is required');
      await addReaction(req.ctx.user!.id, req.params.id!, req.params.messageId!, emoji);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:id/messages/:messageId/react',
    asyncRoute(async (req, res) => {
      const emoji = String(req.body.emoji ?? '').trim();
      await removeReaction(req.ctx.user!.id, req.params.id!, req.params.messageId!, emoji);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/:id/reactions',
    asyncRoute(async (req, res) => res.json(jsonResult({ reactions: await listReactions(req.params.id!) }))),
  );

  router.delete(
    '/:id/messages/:messageId',
    asyncRoute(async (req, res) => {
      await softDeleteMessage(req.ctx.user!.id, req.params.id!, req.params.messageId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  return router;
};

export interface ChatStreamRunResult {
  assistant: string | null;
}

export interface ChatStreamReplay {
  id: string;
  content: string;
}

/**
 * Run the SSE chat stream with hard termination guarantees:
 * - client disconnect (req close) aborts the in-flight generation;
 * - a deadline closes the stream with an honest error even if the work hangs;
 * - every terminal path ends the response — the SSE connection never stays
 *   open indefinitely.
 */
// Registry of in-flight chat streams so server shutdown can abort them
// (otherwise a live stream is only torn down by the process-exit backstop).
const activeStreams = new Set<AbortController>();

export function abortActiveStreams(reason = 'server_shutdown'): void {
  for (const controller of activeStreams) controller.abort(reason);
}

export async function handleChatStream(
  req: ExpressRequest,
  res: ExpressResponse,
  run: (events: ChatStreamEvents & { signal: AbortSignal }) => Promise<ChatStreamRunResult>,
  opts: { deadlineMs: number; replay?: (lastEventId: string) => Promise<ChatStreamReplay[]> },
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Abort propagation: client disconnect and a hard stream deadline both
  // cancel the in-flight generation so the SSE connection ALWAYS closes.
  const controller = new AbortController();
  activeStreams.add(controller);
  let clientGone = false;
  const onClientClose = () => {
    clientGone = true;
    controller.abort('client_closed');
  };
  req.on('close', onClientClose);

  const send = (event: string, data: unknown, id?: string) => {
    if (clientGone || res.destroyed) return;
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let settled = false;
  // Backstop: even if a pre-gateway step (e.g. context retrieval) stalls,
  // the stream is closed within a deterministic, finite window.
  const deadlineTimer = setTimeout(() => controller.abort('stream_timeout'), opts.deadlineMs);
  try {
    const lastEventId = String(req.header('Last-Event-ID') ?? req.header('last-event-id') ?? '');
    if (lastEventId && opts.replay) {
      const replayed = await opts.replay(lastEventId);
      for (const r of replayed) {
        send('delta', { delta: r.content }, `msg_${r.id}`);
      }
    }
    const result = await run({
      signal: controller.signal,
      onThinkingStart: () => send('thinking_start', {}),
      onDelta: (delta) => {
        send('delta', { delta });
      },
      onDone: (info) => {
        send('done', info, info.messageId ? `msg_${info.messageId}` : undefined);
        settled = true;
        res.end();
      },
      onLimitReached: () => send('limit_reached', { showMoon: true }),
    });
    // Deep-work path resolves without streaming events: deliver its
    // confirmation text and close the stream — never leave SSE open.
    if (!settled) {
      if (result.assistant) send('delta', { delta: result.assistant });
      send('done', { messageId: null });
      settled = true;
      res.end();
    }
  } catch (err) {
    if (!settled) {
      if (!clientGone) {
        send(
          'error',
          controller.signal.aborted
            ? { code: 'stream_timeout', message: 'Generation timed out and the stream was closed.' }
            : err instanceof AppError
              ? { code: err.errorCode, message: err.message, details: err.details }
              : { code: 'internal_error', message: 'Internal server error' },
        );
      }
      res.end();
    }
  } finally {
    clearTimeout(deadlineTimer);
    req.removeListener('close', onClientClose);
    activeStreams.delete(controller);
  }
}

export const chatRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    chatLimit(),
    asyncRoute(async (req, res) => {
      const input = chatMessageSchema.parse(req.body);
      const user = await getUserById(req.ctx.user!.id);
      await handleChatStream(req, res, (events) =>
        sendChatMessage(
          { id: user.id, planId: user.planId, entitlementState: user.entitlementState },
          req.ctx.sessionId ?? '',
          input,
          events,
        ),
        {
          deadlineMs: env.AI_CHAIN_TIMEOUT_MS + 15_000,
          replay: (lastEventId) => replayMissedMessages(user.id, input.conversationId, lastEventId),
        },
      );
    }),
  );

  return router;
};