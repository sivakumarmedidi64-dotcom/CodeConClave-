/**
 * CodeConClave — PKG-23 Agent Context (memory → planner/coworker integration).
 *
 * Injects a BOUNDED, evidence-labelled memory context into agent prompts so the
 * planner and coworkers can see prior decisions/patterns/failures. Every item is
 * tagged so the model knows it is memory/inference, never current code. If the
 * feature gate is off or nothing is retrieved, a short neutral block (or empty)
 * is returned — prompts never fail due to memory.
 *
 * MEMORY IS ADVISORY: returned context is clearly labelled and must not override
 * the live repository; the consuming prompt instructions set that boundary.
 */
import { buildCodingContext, type ContextItem } from './codingContext.js';
import { MCP_CONFIG } from './config.js';

const MAX_CONTEXT_ITEMS = 10;

/** Pure renderer — testable without a database. */
export function renderAgentMemoryContext(items: ContextItem[]): string {
  const bounded = items.slice(0, MAX_CONTEXT_ITEMS);
  if (bounded.length === 0) return 'Memory context: (none available)\n';
  const lines = bounded.map((it) => {
    const tag = it.kind === 'CURRENT_CODE_EVIDENCE' ? 'EVIDENCE' : it.kind === 'MEMORY' ? 'MEMORY' : 'SUGGESTION';
    const conf = `(conf=${(it.confidence * 100).toFixed(0)}%)`;
    return `- [${tag}] ${it.label} ${conf}\n  ${it.detail}`;
  });
  return `## Reusable context (prior memory/evidence; for background only — current repository & task instructions take precedence)\n${lines.join('\n')}\n`;
}

/** Retrieve bounded, labelled memory/pattern/decision/evidence context. */
export async function retrieveAgentContext(userId: string, opts: {
  projectId: string;
  file?: string | null;
  symbol?: string | null;
  error?: string | null;
}): Promise<string> {
  if (!MCP_CONFIG.enabled()) return 'Memory context: (feature disabled)\n';
  try {
    const items = await buildCodingContext(userId, {
      projectId: opts.projectId,
      file: opts.file ?? null,
      symbol: opts.symbol ?? null,
      error: opts.error ?? null,
    });
    return renderAgentMemoryContext(items);
  } catch {
    return 'Memory context: (unavailable)\n';
  }
}
