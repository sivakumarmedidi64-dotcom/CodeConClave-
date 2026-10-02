/**
 * CodeConClave — PKG-24 AI Developer Copilot — context-aware suggestions.
 *
 * Suggestions are tied to project context and memory, with explainable
 * rationale and attached evidence. A model synthesizes the suggestion text when
 * a live provider exists; otherwise an honest evidence-based (deterministic)
 * suggestion set is returned with the provider state. We never fabricate
 * model output.
 */
import type { GatewayContext } from '../ai/gateway.js';
import { buildCopilotContext, type CopilotContextDeps } from './context.js';
import { providerState } from './provider.js';
import { runCompletion } from './provider.js';
import { COPILOT_CONFIG } from './config.js';

export interface Suggestion {
  suggestion: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  relatedFiles: string[];
  alternatives: string[];
  source: 'MODEL' | 'HEURISTIC' | 'MEMORY';
}

export interface SuggestResult {
  provider: Awaited<ReturnType<typeof providerState>>;
  suggestions: Suggestion[];
  generatedWithModel: boolean;
}

export interface SuggestInput {
  projectId: string;
  file?: string | null;
  selection?: { line?: number; col?: number; text?: string } | null;
  symbol?: string | null;
  error?: string | null;
  taskId?: string | null;
}

export async function suggestContextAware(
  ctx: GatewayContext,
  input: SuggestInput,
  deps?: CopilotContextDeps,
): Promise<SuggestResult> {
  const provider = await providerState(ctx.userId);
  const context = await buildCopilotContext(ctx.userId, {
    projectId: input.projectId,
    file: input.file ?? null,
    selection: input.selection ?? null,
    symbol: input.symbol ?? null,
    error: input.error ?? null,
    taskId: input.taskId ?? null,
  }, deps);

  const live = provider.state === 'LIVE_PROVIDER' || provider.state === 'LOCAL_MODEL' || provider.state === 'FALLBACK';

  // Explainable memory rationale cards (always available — this is the
  // memory-aware part, independent of a model).
  const memoryCards: Suggestion[] = context.memory.slice(0, 3).map((m) => ({
    suggestion: m.label,
    confidence: m.confidence,
    rationale:
      m.kind === 'MEMORY'
        ? `This project memory is relevant to the current context.`
        : m.kind === 'CURRENT_CODE_EVIDENCE'
          ? `Observed evidence relevant to the current code.`
          : `Suggested as a possible pattern; treat as a suggestion, not fact.`,
    evidence: [m.detail],
    relatedFiles: context.relatedFiles.slice(0, 3),
    alternatives: [],
    source: m.kind === 'MEMORY' ? 'MEMORY' : 'HEURISTIC',
  }));

  // Deterministic/evidence suggestions when no model, plus related-file leads.
  const evidenceSuggestions: Suggestion[] = context.relatedFiles.slice(0, 3).map((f, i) => ({
    suggestion: `Review related file ${f}`,
    confidence: 0.4,
    rationale: `This file is detected as related to the active code.`,
    evidence: ['cross-file reference evidence'],
    relatedFiles: [f],
    alternatives: [],
    source: 'HEURISTIC',
  }));

  let generatedSuggestions: Suggestion[] = [];
  if (live) {
    const userText =
      `${context.guardNote}\n\n` +
      `Given the bounded project context below, provide up to 3 concise, concrete ` +
      `coding suggestions for the active file. For each suggestion give: the suggestion, ` +
      `a confidence 0-1, a short rationale, specific evidence, related files, and up to 2 ` +
      `alternatives. Prefer suggestions supported by the context. Do not fabricate APIs.\n\n` +
      renderContext(context);
    const res = await runCompletion({
      ctx,
      messages: [
        { role: 'system', content: 'You are CodeConClave\'s coding copilot. Provide concrete, evidence-backed coding suggestions.' },
        { role: 'user', content: userText },
      ],
      opts: { computeClass: COPILOT_CONFIG.computeClass, coding: true, coworkerType: 'COPILOT' },
      maxTokens: 900,
    });
    if ('summary' in res) {
      generatedSuggestions = [
        {
          suggestion: res.summary.text,
          confidence: 0.5,
          rationale: 'Synthesized by the model from the bounded context.',
          evidence: context.runtimeEvidence.map((e) => e.detail).slice(0, 3),
          relatedFiles: context.relatedFiles.slice(0, 3),
          alternatives: [],
          source: 'MODEL',
        },
      ];
    }
  }

  const suggestions = [
    ...generatedSuggestions,
    ...(live ? [] : memoryCards),
    ...(live ? memoryCards.slice(0, 1) : evidenceSuggestions),
  ].slice(0, 5);

  return { provider, suggestions, generatedWithModel: live };
}

function renderContext(context: Awaited<ReturnType<typeof buildCopilotContext>>): string {
  const parts: string[] = [];
  for (const c of context.code) parts.push(`--- ${c.path} ---\n${c.snippet}`);
  if (context.memory.length) parts.push(`memory:\n${context.memory.map((m) => `${m.label}: ${m.detail}`).join('\n')}`);
  return parts.join('\n\n');
}
