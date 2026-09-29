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
import { insertMessage, updateMessageStatus, getConversation, toMessageJson, listMessages, findMessageByClientId } from '../conversations/service.js';
import { completeWithFallback, generateImageCompletion, type GatewayContext, type RouteOptions } from '../ai/gateway.js';
import { planRoute } from '../ai/router.js';
import { getModel, configuredProviders } from '../ai/registry.js';
import type { ChatChunk, ChatContentPart } from '../ai/providers.js';
import { getFileContent, persistGeneratedImage } from '../files/service.js';
import { retrieveScopedContext } from '../memory/context.js';
import { extractEpisodicMemory } from '../memory/service.js';
import { extractDecisionFromChat, type ExtractedDecision } from '../memory/extractDecision.js';
import { consumeFreeMessage, incrementUsage, shouldShowFreeLimitMoon, recordUsage } from '../workspace/service.js';
import { UsageCounterName, AuditAction, RoutingPreference, TaskType } from '@codeconclave/shared';
import type { AiModelDescriptor } from '@codeconclave/shared';
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
    /**
     * Continuity: when the completed exchange recorded a decision, the record's
     * id + title + status ride the `done` payload so the UI can show a chip.
     * Absent/null when nothing was recorded — the client never guesses.
     */
    decisionRecorded?: ExtractedDecision | null;
  }) => Promise<void> | void;
  onLimitReached?: () => Promise<void> | void;
  /** Client-side cancellation: propagated to the gateway so provider calls abort. */
  signal?: AbortSignal;
  /**
   * IMAGE_GENERATION event: a generated image was persisted server-side.
   * Carries ONLY the file id + mime (bytes never leave the server contract).
   */
  onImage?: (info: { fileId: string; mimeType: string }) => Promise<void> | void;
  /**
   * EXTERNAL_AGENT run event: provider-reported lifecycle fact (external run
   * id + state). The UI renders it verbatim — it never implies the agent
   * executed anything outside the provider-reported state.
   */
  onExternalRun?: (info: { externalId: string; status: string; message?: string }) => Promise<void> | void;
}

/** Known external-agent registry model ids (honesty guard — never silently substituted). */
const EXTERNAL_AGENT_MODEL_IDS = new Set<string>(['devin-session', 'manus-1.6']);

const MAX_IMAGE_PARTS_PER_MESSAGE = 4;

const SYSTEM_PROMPT = `You are CodeConClave, an AI operating system for software development and knowledge work.

Core identity: MEMORY + EXECUTION + CONTINUITY + TEAM + CONTROL.
- Understand, remember, plan, work, verify, preserve, keep working while the user is away, and never start over.
- Be precise and technical. Prefer concise, structured answers. Use Markdown.
- Never claim an action happened unless you actually performed it. If you cannot verify something, say so.
- Never fabricate file contents, test results, or payment state.
- The user's messages reference a project context that is provided separately. Refer to it as context, not fact about the current device state unless observed.

Operating code (NOVA-COWORK):
- THINK before executing — plan silently, deliver sharply.
- CHALLENGE the user when they are wrong — a yes-man is useless.
- NEVER fake understanding — if unsure, ask one sharp question.
- EXECUTE, don't just advise — show the work, not the theory.
- NO fluff, NO filler, NO disclaimers unless legally critical.
- ANTICIPATE the next needs and prepare before being asked.
- OWN the outcome — if your output fails, fix it instantly.
- SELF-IMPROVEMENT — analyze errors in real time and never repeat them.
- BREAK any goal into sub-goals, prioritize, and execute the full chain independently.
- INSTANT MODE SWITCHING — architect, coder, reviewer, debugger, writer, planner on one command.`;

async function buildMessages(
  userId: string,
  projectId: string | undefined,
  history: { role: string; content: string }[],
  opts: { tone?: string; imageParts?: ChatContentPart[] } = {},
): Promise<{ role: 'user' | 'assistant' | 'system'; content: string | ChatContentPart[] }[]> {
  // The last history entry is the current user turn — exactly the text the
  // decision-retrieval path must match (exact/token overlap, never semantic
  // blur: only recorded decisions that literally share the topic tokens).
  const last = history[history.length - 1];
  const decisionQuery = last && last.role === 'user' ? String(last.content ?? '') : undefined;
  const context = await retrieveScopedContext(userId, { projectId, memoryLimit: 8, dnaLimit: 5, decisionQueryText: decisionQuery });
  const memoryBlock = context.memories.length
    ? `\n\n--- Loaded project memory (context only; verify before relying) ---\n${context.memories.join('\n')}`
    : '';
  const dnaBlock = context.dna.length
    ? `\n\n--- Project DNA (decisions, next actions, blockers; verify before relying) ---\n${context.dna.join('\n')}`
    : '';
  const decisionBlock = context.decisions.length
    ? `\n\n--- Recorded decisions (verifiable records from this account; verify before relying) ---\n${context.decisions.join('\n')}`
    : '';
  const system = env.AI_DEFAULT_MODEL ? SYSTEM_PROMPT : SYSTEM_PROMPT;
  const built: { role: 'user' | 'assistant' | 'system'; content: string | ChatContentPart[] }[] = [
    { role: 'system', content: `${system}${memoryBlock}${dnaBlock}${decisionBlock}${toneInstructions(opts.tone)}` },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];
  // Multimodal INPUT (MULTIMODAL_MODEL capability): the LAST user message is
  // expressed as a normalized part list (text + inline images) so Gemini-style
  // adapters receive real pixels — never a guess. Text-only requests keep the
  // plain-string path untouched.
  if (opts.imageParts && opts.imageParts.length > 0) {
    const last = built[built.length - 1]!;
    const lastText = typeof last.content === 'string' ? last.content : '';
    built[built.length - 1] = { role: last.role, content: [{ type: 'text', text: lastText }, ...opts.imageParts] };
  }
  return built;
}

/**
 * Normalize image attachments into canonical IMAGE_INPUT parts (base64) for
 * the current request. Ownership is enforced by getFileContent (files gateway).
 * Non-image attachments stay in the text block (resolveChatAttachments).
 */
async function resolveImageParts(
  userId: string,
  projectId: string | undefined,
  attachments: { fileId: string; name: string }[] | undefined,
): Promise<ChatContentPart[]> {
  if (!attachments || attachments.length === 0 || !projectId) return [];
  const parts: ChatContentPart[] = [];
  const seen = new Set<string>();
  for (const a of attachments.slice(0, MAX_IMAGE_PARTS_PER_MESSAGE)) {
    if (seen.has(a.fileId)) continue;
    seen.add(a.fileId);
    const { buffer, mimeType } = await getFileContent(userId, projectId, a.fileId);
    if (mimeType?.startsWith('image/')) {
      parts.push({ type: 'image_base64', data: buffer.toString('base64'), mimeType });
    }
  }
  return parts;
}

/**
 * PKG-10 Voice tone: a small additive system-prompt suffix tied to the existing
 * chat response path. It is NOT a separate personality engine; it only nudges the
 * existing LLM. `neutral`/undefined adds nothing.
 */
export function toneInstructions(tone?: string): string {
  switch (tone) {
    case 'CONCISE':
      return '\n\nTone: Be concise. Use short answers, tight bullets, minimal prose.';
    case 'DETAILED':
      return '\n\nTone: Be detailed and thorough. Prefer completeness and depth.';
    case 'FRIENDLY':
      return '\n\nTone: Be friendly and approachable while staying accurate.';
    case 'NEUTRAL':
    default:
      return '';
  }
}

export interface SendMessageResult {
  userMessageId: string;
  assistantMessageId: string | null;
  assistant: string;
  mode: 'CHAT' | 'COWORK' | 'IMAGE' | 'AGENT';
  intent: 'fast' | 'deep';
  limitReached: boolean;
  modelId: string | null;
  costUsd: number;
}

export interface AttachmentPromptPart {
  name: string;
  /** decoded when text-safe; null (with byte size) when the file is binary */
  text?: string;
  binaryBytes?: number;
}

/** Pure prompt-block builder (testable). Collapses many parts into one markdown block. */
export function buildAttachmentBlock(parts: AttachmentPromptPart[]): string {
  if (parts.length === 0) return '';
  const lines: string[] = ['', '----- attached files -----'];
  for (const p of parts) {
    lines.push(`- ${p.name}`);
    if (p.text !== undefined) {
      lines.push('```text');
      lines.push(p.text);
      lines.push('```');
    } else if (p.binaryBytes !== undefined) {
      lines.push(`[binary content — ${p.binaryBytes} bytes; not inlined]`);
    }
  }
  lines.push('----- end attached files -----');
  return lines.join('\n');
}

const MAX_ATTACHMENTS_PER_MESSAGE = 16;
const MAX_TEXT_CHARS_PER_ATTACHMENT = 4_000;
const MAX_TOTAL_BLOCK_CHARS = 24_000;

/**
 * Resolve + verify attachments before they reach the model. Each attachment
 * must belong to the caller's project (ownership enforced by the files
 * gateway) — a tampered/stale attachment id fails the send closed rather than
 * leaking any file content. Returns the prompt block (chat model only; the
 * stored user message keeps its raw content).
 */
export async function resolveChatAttachments(
  userId: string,
  projectId: string | undefined,
  attachments: { fileId: string; name: string }[] | undefined,
): Promise<string> {
  if (!attachments || attachments.length === 0) return '';
  if (!projectId) {
    throw AppError.badRequest('project_required', 'Attaching files to a chat message requires a selected project.');
  }
  const seen = new Set<string>();
  const parts: AttachmentPromptPart[] = [];
  for (const a of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (seen.has(a.fileId)) continue; // dedupe by fileId
    seen.add(a.fileId);
    const { buffer } = await getFileContent(userId, projectId, a.fileId);
    const decoded = buffer.toString('utf8');
    if (decoded.includes('\u0000')) {
      parts.push({ name: a.name, binaryBytes: buffer.length });
    } else {
      parts.push({ name: a.name, text: decoded.slice(0, MAX_TEXT_CHARS_PER_ATTACHMENT) });
    }
  }
  const block = buildAttachmentBlock(parts);
  return block.length > MAX_TOTAL_BLOCK_CHARS ? block.slice(0, MAX_TOTAL_BLOCK_CHARS) + '\n[attachments truncated]' : block;
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

  // IMAGE_GENERATION request (composer Image mode). Canonical gateway op; the
  // produced image is persisted server-side and delivered as an onImage event.
  if (input.imageRequest === true) {
    return sendImageGeneration(userInfo, sessionId, input, events, intent);
  }

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
    // Continuity: a retried send (same clientId, lost ack) must not file a
    // second task. Answer with the already-created task's real status.
    if (input.clientId) {
      const priorMessage = await findMessageByClientId(userInfo.id, conversation.id, input.clientId);
      if (priorMessage) {
        const { findLatestTaskByConversation } = await import('../execution/tasks.js');
        const priorTask = await findLatestTaskByConversation(userInfo.id, conversation.id);
        const assistant = priorTask
          ? `Deep work task already exists — ${priorTask.status === 'WAITING_APPROVAL' ? 'awaiting your approval' : priorTask.status === 'CREATED' ? 'queued for execution' : 'in progress'}. Track it in the 24/7 engine or the Approval Center.`
          : 'Your message was already received — the deep work task is being filed. Track it in the 24/7 engine.';
        await events.onDelta?.(assistant);
        return {
          userMessageId: priorMessage.id,
          assistantMessageId: null,
          assistant,
          mode: 'COWORK',
          intent,
          limitReached: false,
          modelId: null,
          costUsd: 0,
        };
      }
    }
    const attachmentBlock = await resolveChatAttachments(userInfo.id, projectId, input.attachments);
    const userMessageRow = await insertMessage(userInfo.id, {
      conversationId: conversation.id,
      sender: 'USER',
      role: 'user',
      content: input.content,
      status: 'COMPLETED',
      clientId: input.clientId,
    });
    const task = await createTaskFromChat({
      userId: userInfo.id,
      projectId,
      conversationId: conversation.id,
      title: input.content.slice(0, 120),
      description: input.content + attachmentBlock,
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

  // ---- Agent mode (chat-driven laptop automation) -------------------------
  // USER → MODEL → [tool JSON | answer]; tools execute on the ONLINE Local
  // Agent only. Requires an online device; otherwise the message fails closed.
  if (input.mode === 'AGENT') {
    const { agentWs } = await import('../agent/ws.js');
    const deviceId = agentWs().onlineDeviceIds(userInfo.id)[0];
    if (!deviceId) {
      throw AppError.unavailable(
        'local_agent_offline',
        'Agent mode needs your Local Agent online — start it on this computer (codeconclave-agent serve), then resend the message.',
      );
    }
    const { createConversation } = await import('../conversations/service.js');
    let agentConversation = input.conversationId
      ? await getConversation(userInfo.id, input.conversationId)
      : null;
    const agentConversationId = agentConversation?.id ?? input.conversationId;
    const agentResult = await runAgentChatMessage(userInfo, sessionId, input, events, {
      deviceId,
      projectId: input.projectId ?? agentConversation?.project_id ?? undefined,
      conversationId: agentConversationId,
      createConversation: () =>
        createConversation(userInfo.id, { projectId: input.projectId, mode: 'AGENT' }),
    });
    return {
      userMessageId: agentResult.userMessageId,
      assistantMessageId: agentResult.assistantMessageId,
      assistant: agentResult.assistant,
      mode: 'AGENT',
      intent,
      limitReached: false,
      modelId: agentResult.modelId,
      costUsd: agentResult.costUsd,
    };
  }

  // ---- Fast path ----------------------------------------------------------
  //  1. resolve the existing conversation (a retry always carries its id);
  //  2. replay check — a retried send (same clientId, lost ack) replays the
  //     SAME user row and must not consume quota/usage a second time;
  //  3. free-quota gate — runs BEFORE conversation creation so an over-limit
  //     first message still fails honestly with free_limit_reached;
  //  4. create the conversation only for genuinely new sends.
  let conversationId = input.conversationId;
  let conversation = conversationId ? await getConversation(userInfo.id, conversationId) : null;

  const isReplay = conversation
    ? (await findMessageByClientId(userInfo.id, conversation.id, input.clientId)) !== null
    : false;

  if (!isReplay && userInfo.planId === 'free') {
    const consumed = await consumeFreeMessage(userInfo.id);
    if (!consumed.accepted) {
      const showMoon = await shouldShowFreeLimitMoon(userInfo.id);
      if (showMoon) await events.onLimitReached?.();
      throw AppError.badRequest(
        'free_limit_reached',
        `Your usage is currently at its limit (${consumed.usage.limit} messages per ${consumed.usage.windowHours}-hour window). Your access resets after the usage window. Upgrade to Pro for continued access.`,
        {
          reason: 'daily_message_limit',
          limits: { dailyMessages: consumed.usage.limit, windowHours: consumed.usage.windowHours },
          rolling: consumed.usage,
        },
      );
    }
  }

  if (!conversation) {
    const { createConversation } = await import('../conversations/service.js');
    conversation = await createConversation(userInfo.id, {
      projectId: input.projectId,
      mode: input.mode ?? 'CHAT',
    });
  }
  conversationId = conversation.id;

  if (!isReplay) {
    await incrementUsage(userInfo.id, UsageCounterName.DAILY_MESSAGES);
    await recordUsage(userInfo.id, 'messages', 1);
  }

  await events.onThinkingStart?.();
  let userMessageRow;
  try {
    userMessageRow = await insertMessage(userInfo.id, {
      conversationId,
      sender: 'USER',
      role: 'user',
      content: input.content,
      status: 'COMPLETED',
      clientId: input.clientId,
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
  let routingDecision: Awaited<ReturnType<typeof planRoute>> | null = null;
  const projectId = conversation.project_id ?? input.projectId;
  const attachmentBlock = await resolveChatAttachments(userInfo.id, projectId, input.attachments);

  // Multimodal INPUT: image attachments become canonical vision parts so the
  // routed MULTIMODAL_MODEL receives real pixels. needsVision keeps the whole
  // fallback chain vision-capable — pixels never reach a text-only contract.
  const imageParts = await resolveImageParts(userInfo.id, projectId, input.attachments);
  const visionRequest = imageParts.length > 0;

  // EXTERNAL_AGENT honesty guard: when the user pins an external agent the
  // server REQUIRES it enabled AND provider-configured. It is never silently
  // substituted by a normal model; a pinned-but-unavailable agent is an error.
  let externalAgent: AiModelDescriptor | null = null;
  if (input.modelId && EXTERNAL_AGENT_MODEL_IDS.has(input.modelId)) {
    const pinned = await getModel(input.modelId);
    if (!configuredProviders().includes(pinned.providerId)) {
      throw AppError.unavailable(
        'agent_not_configured',
        `${pinned.displayName} requires a configured provider key on the server before it can run.`,
      );
    }
    externalAgent = pinned;
  }

  let opts: RouteOptions = {
    requestedModelId: input.modelId ?? undefined,
    computeClass: 'B',
    privacyClass: 'STANDARD',
    needsVision: visionRequest,
  };
  if (externalAgent) {
    opts = {
      ...opts,
      allowExternalAgents: true,
      taskType: TaskType.AUTONOMOUS_ENGINEERING,
      capability: 'EXTERNAL_AGENT',
    };
  } else {
    // Model Routing 2026: plan a decision when the caller did not pin a model.
    // The server stays authoritative — an explicit user model id is still
    // honored through the gateway's eligibility (health/capability/entitlement).
    try {
      routingDecision = await planRoute({
        userId: userInfo.id,
        text: input.content,
        intent: {
          text: input.content,
          hasImage: Boolean(imageParts.length),
          hasAttachment: Boolean(input.attachments?.length),
        },
        requestedModelId: input.modelId ?? undefined,
        routingPreference: RoutingPreference.AUTO,
        opts: { privacyClass: 'STANDARD', computeClass: 'B' },
      });
      opts = {
        ...opts,
        requestedModelId: routingDecision.selectedModel || undefined,
        computeClass: routingDecision ? undefined : 'B',
        taskType: routingDecision.taskType,
        routingPreference: routingDecision.routingPreference,
      };
    } catch {
      // Routing never blocks chat: fall back to legacy compute-class routing.
      routingDecision = null;
    }
  }
  try {
    summary = await completeWithFallback({
      ctx,
      messages: await buildMessages(userInfo.id, projectId, [
        ...historyMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: input.content + attachmentBlock },
      ], { tone: input.tone, imageParts: visionRequest ? imageParts : undefined }),
      opts,
      maxTokens: 4096,
      signal: events.signal,
      onChunk: async (chunk: ChatChunk) => {
        fullText += chunk.delta;
        if (chunk.externalRun) {
          await events.onExternalRun?.({
            externalId: chunk.externalRun.externalId,
            status: chunk.externalRun.status,
          });
        }
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
      correlationId: undefined,
    });
    throw err;
  }

  // Audit the external-agent run lifecycle (honest, provider-reported facts).
  if (externalAgent && summary?.externalRun) {
    await recordAudit({
      action: 'ai.external_agent_run',
      actorUserId: userInfo.id,
      scope: 'USER',
      tenantId: userInfo.id,
      resourceType: 'conversation',
      resourceId: conversationId,
      detail: {
        messageId: assistantMessage.id,
        agent: externalAgent.modelId,
        providerId: externalAgent.providerId,
        externalRunId: summary.externalRun.externalId,
        status: summary.externalRun.status,
        taskType: 'AUTONOMOUS_ENGINEERING',
      },
    });
  }

  // Background extraction of episodic memory (never blocks the response).
  void extractEpisodicMemory({
    userId: userInfo.id,
    conversationId,
    projectId: conversation.project_id ?? undefined,
    content: input.content,
    response: fullText,
  }).catch(() => undefined);

  // Conservative decision recording after a completed exchange. Deterministic
  // and cheap (an indexed query or two); the result rides the SSE `done`
  // payload so the UI can show a real chip. If it ever fails the stream must
  // never fail — hence the swallow.
  let decisionRecorded: ExtractedDecision | null = null;
  if (!input.imageRequest) {
    decisionRecorded = await extractDecisionFromChat(userInfo.id, {
      conversationId,
      projectId: conversation.project_id ?? null,
      content: input.content,
      messageId: userMessageRow.id,
    }).catch(() => null);
  }

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
    decisionRecorded,
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

/**
 * AGENT-mode turn: quota gate → persist user message + history → runAgentLoop
 * (model ↔ local agent tool loop) → persist assistant message + usage/audit.
 */
async function runAgentChatMessage(
  userInfo: { id: string; planId: 'free' | 'pro' | 'team' | 'enterprise'; entitlementState: string },
  sessionId: string,
  input: ChatMessageInput,
  events: ChatStreamEvents,
  opts: {
    deviceId: string;
    projectId?: string;
    conversationId?: string;
    createConversation: () => Promise<{ id: string; project_id: string | null }>;
  },
): Promise<{
  userMessageId: string;
  assistantMessageId: string | null;
  assistant: string;
  modelId: string | null;
  costUsd: number;
}> {
  const conversation = opts.conversationId
    ? await getConversation(userInfo.id, opts.conversationId)
    : await opts.createConversation();
  const conversationId = conversation.id;

  const isReplay = opts.conversationId
    ? (await findMessageByClientId(userInfo.id, conversationId, input.clientId)) !== null
    : false;

  if (!isReplay && userInfo.planId === 'free') {
    const consumed = await consumeFreeMessage(userInfo.id);
    if (!consumed.accepted) {
      const showMoon = await shouldShowFreeLimitMoon(userInfo.id);
      if (showMoon) await events.onLimitReached?.();
      throw AppError.badRequest(
        'free_limit_reached',
        `Your usage is currently at its limit (${consumed.usage.limit} messages per ${consumed.usage.windowHours}-hour window). Your access resets after the usage window. Upgrade to Pro for continued access.`,
        {
          reason: 'daily_message_limit',
          limits: { dailyMessages: consumed.usage.limit, windowHours: consumed.usage.windowHours },
          rolling: consumed.usage,
        },
      );
    }
  }

  if (!isReplay) {
    await incrementUsage(userInfo.id, UsageCounterName.DAILY_MESSAGES);
    await recordUsage(userInfo.id, 'messages', 1);
  }

  await events.onThinkingStart?.();
  const userMessageRow = await insertMessage(userInfo.id, {
    conversationId,
    sender: 'USER',
    role: 'user',
    content: input.content,
    status: 'COMPLETED',
    clientId: input.clientId,
  });

  const history = await listMessages(userInfo.id, conversationId, undefined, 30);
  const historyMessages = history
    .filter((m) => m.id !== userMessageRow.id)
    .reverse()
    .map(toMessageJson)
    .slice(-20);

  const assistantMessage = await insertMessage(userInfo.id, {
    conversationId,
    sender: 'AI',
    role: 'assistant',
    content: '',
    status: 'STREAMING',
  });

  const { runAgentLoop } = await import('./agentChat.js');
  const ctx: GatewayContext = { userId: userInfo.id, sessionId, conversationId, planId: userInfo.planId };
  const result = await runAgentLoop({
    ctx,
    userId: userInfo.id,
    deviceId: opts.deviceId,
    messages: historyMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    currentUserText: input.content,
    events,
    routeOpts: { requestedModelId: input.modelId ?? undefined, computeClass: 'B', privacyClass: 'STANDARD' },
  });

  await events.onDelta?.(result.text);
  await updateMessageStatus(assistantMessage.id, {
    status: 'COMPLETED',
    content: result.text,
    modelId: result.modelId ?? undefined,
    providerId: result.providerId ?? undefined,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.durationMs,
  });

  await recordUsage(userInfo.id, 'ai_input_tokens', result.inputTokens, { measured: true, unit: 'tokens' });
  await recordUsage(userInfo.id, 'ai_output_tokens', result.outputTokens, { measured: true, unit: 'tokens' });
  if (result.costUsd > 0) {
    await recordUsage(userInfo.id, 'compute_cost_usd', result.costUsd, {
      measured: false,
      unit: 'usd',
      meta: { modelId: result.modelId, providerId: result.providerId },
    });
  }

  await events.onDone?.({
    messageId: assistantMessage.id,
    modelId: result.modelId ?? '',
    providerId: result.providerId ?? '',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });

  await recordAudit({
    action: AuditAction.MESSAGE_CREATED,
    actorUserId: userInfo.id,
    scope: 'USER',
    tenantId: userInfo.id,
    resourceType: 'conversation',
    resourceId: conversationId,
    detail: { messageId: assistantMessage.id, model: result.modelId ?? null, steps: result.steps },
  });

  return {
    userMessageId: userMessageRow.id,
    assistantMessageId: assistantMessage.id,
    assistant: result.text,
    modelId: result.modelId,
    costUsd: result.costUsd,
  };
}

/**
 * IMAGE_GENERATION request (composer Image mode). Canonical gateway op —
 * the produced image is persisted server-side (message-attached file) and the
 * client receives ONLY fileId + mime via the onImage event. A project is
 * required for persistence, mirroring the existing attachments rule.
 */
async function sendImageGeneration(
  userInfo: { id: string; planId: 'free' | 'pro' | 'team' | 'enterprise' },
  sessionId: string,
  input: ChatMessageInput,
  events: ChatStreamEvents,
  intent: 'fast' | 'deep',
): Promise<SendMessageResult> {
  await events.onThinkingStart?.();

  const { createConversation } = await import('../conversations/service.js');
  const conversation = input.conversationId
    ? await getConversation(userInfo.id, input.conversationId)
    : await createConversation(userInfo.id, { projectId: input.projectId, mode: 'IMAGE' });

  const projectId = input.projectId ?? conversation.project_id ?? undefined;
  if (!projectId) {
    throw AppError.badRequest('project_required', 'Image generation requires an active project: create or select one first.');
  }

  // Continuity: same replay rule as the fast path — a retried image prompt
  // replays the user row without consuming quota twice.
  const isImageReplay = input.conversationId
    ? (await findMessageByClientId(userInfo.id, conversation.id, input.clientId)) !== null
    : false;

  if (!isImageReplay && userInfo.planId === 'free') {
    const consumed = await consumeFreeMessage(userInfo.id);
    if (!consumed.accepted) {
      const showMoon = await shouldShowFreeLimitMoon(userInfo.id);
      if (showMoon) await events.onLimitReached?.();
      throw AppError.badRequest(
        'free_limit_reached',
        `Your usage is currently at its limit (${consumed.usage.limit} messages per ${consumed.usage.windowHours}-hour window). Upgrade to Pro for continued access.`,
        { reason: 'daily_message_limit', limits: { dailyMessages: consumed.usage.limit, windowHours: consumed.usage.windowHours }, rolling: consumed.usage },
      );
    }
  }

  if (!isImageReplay) {
    await incrementUsage(userInfo.id, UsageCounterName.DAILY_MESSAGES);
  }

  const userMessageRow = await insertMessage(userInfo.id, {
    conversationId: conversation.id,
    sender: 'USER',
    role: 'user',
    content: input.content,
    status: 'COMPLETED',
    clientId: input.clientId,
  });
  const assistantMessage = await insertMessage(userInfo.id, {
    conversationId: conversation.id,
    sender: 'AI',
    role: 'assistant',
    content: '',
    status: 'STREAMING',
  });

  let fullText = '';
  let persistedImage: { fileId: string; mimeType: string } | undefined;
  let summary: Awaited<ReturnType<typeof generateImageCompletion>> | null = null;
  try {
    summary = await generateImageCompletion(
      { userId: userInfo.id, sessionId, conversationId: conversation.id, planId: userInfo.planId },
      input.content,
      {
        requestedModelId: input.modelId && input.modelId !== 'AUTO' ? input.modelId : undefined,
        signal: events.signal,
        onChunk: async (chunk: ChatChunk) => {
          fullText += chunk.delta;
          if (chunk.image && !persistedImage) {
            const persisted = await persistGeneratedImage(userInfo.id, projectId, {
              dataB64: chunk.image.dataB64,
              mimeType: chunk.image.mimeType,
              messageId: assistantMessage.id,
              prompt: input.content,
            });
            persistedImage = { fileId: persisted.fileId, mimeType: persisted.mimeType };
            await events.onImage?.(persistedImage);
          }
          await events.onDelta?.(chunk.delta);
        },
      },
    );
  } catch (error) {
    await updateMessageStatus(assistantMessage.id, {
      status: 'FAILED',
      content: fullText || 'Image generation failed.',
      errorCode: error instanceof AppError ? error.errorCode : 'internal_error',
    });
    await recordAudit({
      action: 'ai.image_generation_failed',
      actorUserId: userInfo.id,
      scope: 'USER',
      tenantId: userInfo.id,
      resourceType: 'conversation',
      resourceId: conversation.id,
      detail: { messageId: assistantMessage.id, capability: 'IMAGE_GENERATION', taskType: 'IMAGE_GENERATION', error: error instanceof Error ? error.message : 'unknown' },
    });
    throw error;
  }

  await updateMessageStatus(assistantMessage.id, {
    status: 'COMPLETED',
    content: fullText,
    modelId: summary.modelId,
    providerId: summary.providerId,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    latencyMs: summary.durationMs,
    imageFileId: persistedImage?.fileId ?? null,
    imageMime: persistedImage?.mimeType ?? null,
  });

  await recordAudit({
    action: 'ai.image_generated',
    actorUserId: userInfo.id,
    scope: 'USER',
    tenantId: userInfo.id,
    resourceType: 'file',
    resourceId: persistedImage?.fileId ?? null,
    detail: {
      messageId: assistantMessage.id,
      model: summary.modelId,
      providerId: summary.providerId,
      capability: 'IMAGE_GENERATION',
      taskType: 'IMAGE_GENERATION',
      fileId: persistedImage?.fileId ?? null,
    },
  });

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
    modelId: summary.modelId,
    providerId: summary.providerId,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    costUsd: summary.estimatedCostUsd,
    durationMs: summary.durationMs,
  });

  return {
    userMessageId: userMessageRow.id,
    assistantMessageId: assistantMessage.id,
    assistant: fullText,
    mode: 'IMAGE',
    intent,
    limitReached: false,
    modelId: summary.modelId,
    costUsd: summary.estimatedCostUsd,
  };
}