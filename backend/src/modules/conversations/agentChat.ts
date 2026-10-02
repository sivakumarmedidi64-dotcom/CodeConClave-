/**
 * CodeConClave — Agent chat mode (the selected model driving the laptop).
 *
 * A bounded, policy-gated tool loop inside a normal chat conversation:
 *   model → [tool JSON | final answer]
 *   tool → deterministic policy → execute on the ONLINE LOCAL AGENT → result
 *         fed back to the model → next iteration.
 *
 * The local agent runs every command in its granted workspace roots with its
 * own deny-by-default policy; the cloud policy engine additionally gates each
 * typed tool call before it is dispatched. LOW-risk tools (terminal_exec for
 * allowlisted commands, file_read, file_list, browser_open) execute
 * automatically; anything requiring approval stops the loop with an honest
 * message instead of executing. Nothing is ever faked.
 */
import { AppError } from '../../shared/errors.js';
import { completeWithFallback, type GatewayContext, type RouteOptions } from '../ai/gateway.js';
import type { ChatMessage } from '../ai/providers.js';
import type { ChatStreamEvents } from './chat.js';
import { agentWs, type CommandExecResult } from '../agent/ws.js';
import { evaluateToolCall } from '../execution/policy.js';
import { logger } from '../../shared/logger.js';

export const AGENT_MODE_TOOLS = ['terminal_exec', 'file_list', 'file_read', 'file_write', 'browser_open'] as const;
export type AgentTool = (typeof AGENT_MODE_TOOLS)[number];

/** Deterministic tool → local-agent command mapping. Keys are policy tool ids. */
const AGENT_TOOL_COMMANDS: Record<AgentTool, string> = {
  terminal_exec: 'terminal.exec',
  file_list: 'file.list',
  file_read: 'file.read',
  file_write: 'file.write',
  browser_open: 'browser.open',
};

const MAX_AGENT_STEPS = 6;
const RESULT_CAP_CHARS = 8_000;
const ITERATION_OUTPUT_CAP = 32_000;

const RUNTIME_PROMPT = `You are operating the user's local machine through CodeConClave's Local Agent. You may run real commands and open files, but you MUST think before you act and stop as soon as the goal is done.

Available tools:
- terminal_exec: input {"command":"<shell command>","timeoutMs":<optional ms>} — runs one command in the granted workspace and returns its output. Use for building, testing, listing, or any real action.
- file_list: input {"path":"<relative path>"} — list a directory inside the workspace.
- file_read: input {"path":"<relative path>"} — read a file inside the workspace (small files; use terminal for big ones).
- file_write: input {"path":"<relative path>","content":"<full new content>"} — overwrite a file inside the workspace (requires approval; may be refused).
- browser_open: input {"url":"<http(s) url>"} — open a URL in the user's browser.

Rules:
- When you need to perform an action, respond with ONLY a single JSON object of the form {"tool":"...","input":{...}}. No prose, no markdown, no comments around it.
- When the goal is achieved (or impossible), respond with a normal markdown answer summarizing what you actually did with real evidence, and what remains. Never claim an action you did not perform.
- Paths are relative to the workspace root. Never touch secrets (.env, .ssh, credentials) — the policy engine will block them.
- Run at most a few commands; stop early when the task is complete.`;

export interface AgentChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelId: string | null;
  providerId: string | null;
  steps: number;
  durationMs: number;
}

function extractToolJson(text: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const candidate of [trimmed, trimmed.replace(/^```(?:json)?[^\n]*\n?/, '')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.tool === 'string' && parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)) {
        return { tool: parsed.tool as string, input: parsed.input as Record<string, unknown> };
      }
    } catch {
      /* not this candidate */
    }
  }
  if (AGENT_MODE_TOOLS.some((t) => trimmed.includes(`"${t}"`))) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        if (parsed && typeof parsed.tool === 'string' && parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)) {
          return { tool: parsed.tool as string, input: parsed.input as Record<string, unknown> };
        }
      } catch {
        /* malformed inline JSON — treat as prose */
      }
    }
  }
  return null;
}

export function extractToolJsonForTest(text: string): { tool: string; input: Record<string, unknown> } | null {
  return extractToolJson(text);
}

/**
 * Run the agent loop for one chat turn. Enforces: online device required,
 * bounded steps, deterministic policy on EVERY tool call, and a hard cap on
 * the length of tool output fed back into the model context.
 */
export async function runAgentLoop(input: {
  ctx: GatewayContext;
  userId: string;
  deviceId: string;
  messages: ChatMessage[];
  currentUserText: string;
  events: ChatStreamEvents;
  routeOpts?: RouteOptions;
  maxSteps?: number;
}): Promise<AgentChatResult> {
  const maxSteps = Math.min(input.maxSteps ?? MAX_AGENT_STEPS, MAX_AGENT_STEPS);
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let modelId: string | null = null;
  let providerId: string | null = null;
  let steps = 0;

  const runtime = [...input.messages, { role: 'user' as const, content: input.currentUserText }];
  const leftovers: ChatMessage[] = [];
  let finalText = '';

  for (let step = 0; step < maxSteps; step += 1) {
    steps += 1;
    let text = '';
    let summary: Awaited<ReturnType<typeof completeWithFallback>> | null = null;
    try {
      summary = await completeWithFallback({
        ctx: input.ctx,
        messages: [...runtime, ...leftovers, { role: 'system', content: RUNTIME_PROMPT }],
        opts: { ...(input.routeOpts ?? {}), computeClass: 'B', privacyClass: 'STANDARD' },
        maxTokens: 900,
        signal: input.events.signal,
        onChunk: (chunk) => {
          text += chunk.delta;
        },
      });
    } catch (err) {
      const what = err instanceof AppError ? `${err.errorCode}: ${err.message}` : err instanceof Error ? err.message : 'model failed';
      finalText = finalText || `The agent hit a model error while thinking: ${what}`;
      break;
    }

    if (summary) {
      inputTokens += summary.inputTokens;
      outputTokens += summary.outputTokens;
      costUsd += summary.estimatedCostUsd;
      modelId = summary.modelId || modelId;
      providerId = summary.providerId || providerId;
    }

    const tool = extractToolJson(text);
    if (!tool) {
      finalText = text;
      break;
    }

    if (!AGENT_TOOL_COMMANDS[tool.tool as AgentTool]) {
      finalText = `The agent tried an unknown tool "${tool.tool}" — tell it to pick from ${AGENT_MODE_TOOLS.join(', ')}.`;
      break;
    }

    const decision = evaluateToolCall({ tool: tool.tool, input: tool.input, userId: input.userId });
    if (!decision.allowed) {
      finalText = `The agent's requested action was blocked by policy (${decision.deniedBy}: ${decision.reason}). No action was taken on your machine. Ask it to adjust.`;
      break;
    }
    if (decision.requiresApproval) {
      finalText = `The agent requested a ${decision.risk} risk action that requires your approval in the Approval Center. No action was taken on your machine.`;
      break;
    }

    await input.events.onDelta?.(
      `> **Agent step ${step + 1}** — \`${tool.tool}\`${tool.tool === 'terminal_exec' ? ` $ ${String(tool.input.command ?? '').slice(0, 200)}` : tool.tool === 'browser_open' ? ` opening ${String(tool.input.url ?? '').slice(0, 200)}` : ` ${String(tool.input.path ?? tool.input.url ?? '').slice(0, 200)}`}\n`,
    );

    let result: CommandExecResult;
    try {
      result = await agentWs().executeCommandResult(input.userId, input.deviceId, {
        kind: AGENT_TOOL_COMMANDS[tool.tool as AgentTool],
        ...tool.input,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'device unreachable';
      await input.events.onDelta?.(`> Action failed: ${msg}\n`);
      finalText = `The action could not be delivered to your machine: ${msg}. Is the Local Agent still online?`;
      break;
    }

    const output = result.error
      ? `[error] ${result.error}`
      : [result.output, result.payload ? `\n${JSON.stringify(result.payload).slice(0, 2_000)}` : ''].join('');
    const capped = output.length > RESULT_CAP_CHARS ? `${output.slice(0, RESULT_CAP_CHARS)}\n[output truncated for the model]` : output;

    await input.events.onDelta?.(`\`\`\`\n${capped.slice(0, 4_000)}\n\`\`\`\n`);
    leftovers.push({ role: 'user', content: `Tool ${tool.tool} result (was ok=${result.ok}):\n${capped}` });
    if (result.ok && tool.tool === 'terminal_exec') {
      await input.events.onDelta?.('> *ok — continuing.*\n');
    }
    if (!result.ok && /policy_denied/i.test(output)) {
      finalText = 'The Local Agent rejected the command under its own policy — nothing was executed on your machine.';
      break;
    }

    if (leftovers.join('').length > ITERATION_OUTPUT_CAP) {
      finalText = finalText || 'The agent accumulated too much tool output; stopping the loop to protect your machine.';
      break;
    }
  }

  if (!finalText) {
    finalText = steps >= maxSteps ? 'The agent reached its step budget without producing a final answer.' : '(no response)';
  }

  return { text: finalText, inputTokens, outputTokens, costUsd, modelId, providerId, steps, durationMs: Date.now() - started };
}