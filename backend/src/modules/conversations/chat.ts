/**
 * CodeConClave — chat pipeline (fast path + deep work path entry).
 *
 * Fast path:  USER → AI GATEWAY → STREAM → DONE
 * Deep path:  USER → PLANNER → COWORKER GRAPH → EXECUTION (see workflows module);
 *             this service creates the task + coworker pipeline for Deep Work.
 *
 * Server-side authority: free-limit checks, memory scoping (current project
 * only by default), model routing with compute governance.
 */
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { insertMessage, updateMessageStatus, getConversation, toMessageJson, listMessages } from '../conversations/service.js';
import { completeWithFallback, type GatewayContext } from '../ai/gateway.js';
import type { ChatChunk } from '../ai/providers.js';
import { retrieveScopedContext } from '../memory/context.js';
import { extractEpisodicMemory } from '../memory/service.js';
import { checkFreeLimits, incrementUsage, shouldShowFreeLimitMoon, recordUsage } from '../workspace/service.js';
import { UsageCounterName, AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import type { ChatMessageInput } from '@codeconclave/shared';
import { env } from '../../config/env.js';
import { triageIntent } from './intent.js';

export interface ChatStreamEvents {
  onThinkingStart?: () => Promise<void> | void;
  onDelta?: (delta: string) => Promise<void> | void;
  onDone?: (info: {
    messageId: string;
    modelId: string;
    providerId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
  }) => Promise<void> | void;
  onLimitReached?: () => Promise<void> | void;
  /** Client-side cancellation: propagated to the gateway so provider calls abort. */
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are CodeConClave, an AI operating system for software development and knowledge work.

Core identity: MEMORY + EXECUTION + CONTINUITY + TEAM + CONTROL.
- Understand, remember, plan, work, verify, preserve, keep working while the user is away, and never start over.
- Be precise and technical. Prefer concise, structured answers. Use Markdown.
- Never claim an action happened unless you actually performed it. If you cannot verify something, say so.
- Never fabricate file contents, test results, or payment state.
- The user's messages reference a project context that is provided separately. Refer to it as context, not fact about the current device state unless observed.`;

async function buildMessages(userId: string, projectId: string | undefined, history: { role: string; content: string }[]): Promise<{ role: 'user' | 'assistant' | 'system'; content: string }[]> {
  const context = await retrieveScopedContext(userId, { projectId, memoryLimit: 8, dnaLimit: 5 });
  const memoryBlock = context.memories.length
    ? `\n\n--- Loaded project memory (context only; verify before relying) ---\n${context.memories.join('\n')}`
    : '';
  const dnaBlock = context.dna.length
    ? `\n\n--- Project DNA (decisions, next actions, blockers; verify before relying) ---\n${context.dna.join('\n')}`
    : '';
  const system = env.AI_DEFAULT_MODEL ? SYSTEM_PROMPT : SYSTEM_PROMPT;
  return [
    { role: 'system', content: `${system}${memoryBlock}${dnaBlock}` },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];
}

export interface SendMessageResult {
  userMessageId: string;
  assistantMessageId: string | null;
  assistant: string | null;
  mode: 'CHAT' | 'COWORK';
  intent: 'fast' | 'deep';
  limitReached: boolean;
  modelId: string | null;
  costUsd: number;
}

/**
 * Send a message in a conversation. For COWORK-mode deep-work requests, this
 * creates a task in the workflow engine instead of a plain response.
 */
export async function sendChatMessage(
  userInfo: { id: string; planId: 'free' | 'pro' | 'team' | 'enterprise'; entitlementState: string },
  sessionId: string,
  input: ChatMessageInput,
  events: ChatStreamEvents = {},
): Promise<SendMessageResult> {
  const intent = triageIntent(input.content);

  if (input.mode === 'COWORK' && intent === 'deep') {
    // ---- Deep work path ----------------------------------------------------
    // Creates a persisted task + coworker pipeline in the execution engine.
    const { createTaskFromChat } = await import('../execution/orchestrator.js');
    const { createConversation } = await import('../conversations/service.js');
    const conversation = input.conversationId
      ? await getConversation(userInfo.id, input.conversationId)
      : await createConversation(userInfo.id, { projectId: input.projectId, mode: 'COWORK' });
    const projectId = input.projectId ?? conversation.project_id ?? '';
    if (!projectId) {
      throw AppError.badRequest(
        'project_required',
        'Deep work needs a project — create one or select it in the Chat page first.',
      );
    }
    const userMessageRow = await insertMessage(userInfo.id, {
      conversationId: conversation.id,
      sender: 'USER',
      role: 'user',
      content: input.content,
      status: 'COMPLETED',
    });
    const task = await createTaskFromChat({
      userId: userInfo.id,
      projectId,
      conversationId: conversation.id,
      title: input.content.slice(0, 120),
      description: input.content,
    });
    const assistant = `Deep work task created — ${task.status === 'WAITING_APPROVAL' ? 'awaiting your approval' : task.status === 'CREATED' ? 'queued for execution' : 'in progress'}. Track it in the 24/7 engine or the Approval Center.`;
    // The deep-work path completes without a model stream; deliver the
    // confirmation text so the SSE stream carries a real terminal event.
    await events.onDelta?.(assistant);
    return {
      userMessageId: userMessageRow.id,
      assistantMessageId: null,
      assistant,
      mode: 'COWORK',
      intent,
      limitReached: false,
      modelId: null,
      costUsd: 0,
    };
  }

  // ---- Fast path ----------------------------------------------------------
  const limit = await checkFreeLimits(userInfo.id, 'message');
  if (!limit.ok && userInfo.planId === 'free') {
    const showMoon = await shouldShowFreeLimitMoon(userInfo.id);
    if (showMoon) await events.onLimitReached?.();
    throw AppError.badRequest(
      'free_limit_reached',
      `You've reached today's free usage limit (${env.FREE_DAILY_MESSAGES} messages). Your work is safe. Upgrade to Pro for unlimited usage.`,
      { reason: limit.reason, limits: limit.limits },
    );
  }

  let conversationId = input.conversationId;
  let conversation = conversationId ? await getConversation(userInfo.id, conversationId) : null;
  if (!conversation) {
    const { createConversation } = await import('../conversations/service.js');
    conversation = await createConversation(userInfo.id, {
      projectId: input.projectId,
      mode: input.mode ?? 'CHAT',
    });
  }
  conversationId = conversation.id;

  await incrementUsage(userInfo.id, UsageCounterName.DAILY_MESSAGES);
  await recordUsage(userInfo.id, 'messages', 1);

  await events.onThinkingStart?.();
  let userMessageRow;
  try {
    userMessageRow = await insertMessage(userInfo.id, {
      conversationId,
      sender: 'USER',
      role: 'user',
      content: input.content,
      status: 'COMPLETED',
    });
  } catch (err) {
    await events.onDone?.({
      messageId: '',
      modelId: '',
      providerId: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
    });
    throw err;
  }

  const history = await listMessages(userInfo.id, conversationId, undefined, 40);
  const historyMessages = history
    .filter((m) => m.id !== userMessageRow.id)
    .reverse()
    .map(toMessageJson)
    .slice(-24);

  const ctx: GatewayContext = {
    userId: userInfo.id,
    sessionId,
    conversationId,
    planId: userInfo.planId,
  };

  const assistantMessage = await insertMessage(userInfo.id, {
    conversationId,
    sender: 'AI',
    role: 'assistant',
    content: '',
    status: 'STREAMING',
  });

  let fullText = '';
  let summary: Awaited<ReturnType<typeof completeWithFallback>> | null = null;
  try {
    summary = await completeWithFallback({
      ctx,
      messages: await buildMessages(userInfo.id, conversation.project_id ?? input.projectId, [
        ...historyMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: input.content },
      ]),
      opts: {
        requestedModelId: input.modelId ?? undefined,
        computeClass: 'B',
        privacyClass: 'STANDARD',
      },
      maxTokens: 4096,
      signal: events.signal,
      onChunk: async (chunk: ChatChunk) => {
        fullText += chunk.delta;
        await events.onDelta?.(chunk.delta);
      },
    });
    await updateMessageStatus(assistantMessage.id, {
      status: 'COMPLETED',
      content: fullText,
      modelId: summary.modelId,
      providerId: summary.providerId,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      latencyMs: summary.durationMs,
    });
  } catch (err) {
    await updateMessageStatus(assistantMessage.id, {
      status: 'FAILED',
      content: fullText || `Request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      errorCode: err instanceof AppError ? err.errorCode : 'internal_error',
    });
    await recordAudit({
      action: 'chat.failed',
      actorUserId: userInfo.id,
      scope: 'USER',
      tenantId: userInfo.id,
      resourceType: 'conversation',
      resourceId: conversationId,
      detail: { error: err instanceof Error ? err.message : 'unknown' },
      traceId: undefined,
    });
    throw err;
  }

  // Background extraction of episodic memory (never blocks the response).
  void extractEpisodicMemory({
    userId: userInfo.id,
    conversationId,
    projectId: conversation.project_id ?? undefined,
    content: input.content,
    response: fullText,
  }).catch(() => undefined);

  if (summary) {
    await recordUsage(userInfo.id, 'ai_input_tokens', summary.inputTokens, { measured: true, unit: 'tokens' });
    await recordUsage(userInfo.id, 'ai_output_tokens', summary.outputTokens, { measured: true, unit: 'tokens' });
    if (summary.estimatedCostUsd > 0) {
      await recordUsage(userInfo.id, 'compute_cost_usd', summary.estimatedCostUsd, {
        measured: false,
        unit: 'usd',
        meta: { modelId: summary.modelId, providerId: summary.providerId },
      });
    }
  }

  await events.onDone?.({
    messageId: assistantMessage.id,
    modelId: summary?.modelId ?? '',
    providerId: summary?.providerId ?? '',
    inputTokens: summary?.inputTokens ?? 0,
    outputTokens: summary?.outputTokens ?? 0,
    costUsd: summary?.estimatedCostUsd ?? 0,
    durationMs: summary?.durationMs ?? 0,
  });

  await recordAudit({
    action: AuditAction.MESSAGE_CREATED,
    actorUserId: userInfo.id,
    scope: 'USER',
    tenantId: userInfo.id,
    resourceType: 'conversation',
    resourceId: conversationId,
    detail: { messageId: assistantMessage.id, model: summary?.modelId ?? null },
  });

  return {
    userMessageId: userMessageRow.id,
    assistantMessageId: assistantMessage.id,
    assistant: fullText,
    mode: input.mode ?? 'CHAT',
    intent,
    limitReached: false,
    modelId: summary?.modelId ?? null,
    costUsd: summary?.estimatedCostUsd ?? 0,
  };
}