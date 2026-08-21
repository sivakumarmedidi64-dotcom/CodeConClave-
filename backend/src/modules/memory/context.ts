/**
 * CodeConClave — scoped context retrieval for the chat pipeline (Phase 6).
 *
 * Combines project-scoped memory (confidence-gated, source-labeled) with the
 * project's MAIN DNA blocks (decisions, next actions, blockers, context).
 * Both are prompt-safe: contradicted/unverified memory is gated by the memory
 * service; conflicting DNA is excluded here.
 */
import { retrieveMemoriesForPrompt } from './service.js';
import { retrieveDnaForPrompt } from '../dna/service.js';
import { recordLatencyMetric } from '../../observability/metrics.js';

export interface ScopedContext {
  memories: string[];
  dna: string[];
}

export async function retrieveScopedContext(
  userId: string,
  opts: { projectId?: string | null; memoryLimit?: number; dnaLimit?: number },
): Promise<ScopedContext> {
  const startedAt = Date.now();
  const [memories, dna] = await Promise.all([
    retrieveMemoriesForPrompt(userId, opts.projectId ?? null, opts.memoryLimit ?? 8),
    retrieveDnaForPrompt(userId, opts.projectId ?? null, opts.dnaLimit ?? 5),
  ]);
  recordLatencyMetric('memory_retrieve_ms', Date.now() - startedAt);
  return { memories, dna };
}