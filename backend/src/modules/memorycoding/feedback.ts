/**
 * CodeConClave — PKG-23 Feedback & Learning Into Memory.
 *
 * Feedback is classified by how much it can be trusted:
 *   - OBSERVED  : seen in behavior, not yet confirmed by user or system.
 *   - CONFIRMED : corroborated by a second independent observation.
 *   - EXPLICIT  : the user/team directly stated it (most authoritative).
 *   - INFERRED  : derived suggestion, never promoted to fact.
 * OBSERVED/INFERRED never override EXPLICIT/CONFIRMED. Feedback writes go
 * through the existing memory + secret redaction layers; no fabricated records.
 *
 * INFERRED feedback is never persisted as a fact: it returns a no-op marker so
 * the caller knows the suggestion was not stored.
 */
import { MemorySource, MemoryType } from '@codeconclave/shared';
import { createMemory } from '../memory/service.js';

export type FeedbackLevel = 'OBSERVED' | 'CONFIRMED' | 'EXPLICIT' | 'INFERRED';

export interface MemoryFeedbackInput {
  projectId?: string | null;
  content: string;
  level: FeedbackLevel;
  source?: string;
  structured?: Record<string, unknown>;
}

const SOURCE_BY_LEVEL: Record<Exclude<FeedbackLevel, 'INFERRED'>, MemorySource> = {
  OBSERVED: MemorySource.OBSERVED,
  CONFIRMED: MemorySource.OBSERVED,
  EXPLICIT: MemorySource.USER_STATED,
};

/**
 * Write an observed/confirmed/explicit learning back to persistent memory.
 * INFERRED is deliberately NOT stored (returns { stored: false }).
 */
export async function learnFromFeedback(
  userId: string,
  input: MemoryFeedbackInput,
): Promise<unknown> {
  if (input.level === 'INFERRED') {
    return { stored: false, reason: 'inferred_feedback_not_persisted' };
  }
  const source = SOURCE_BY_LEVEL[input.level];
  const memory = await createMemory(userId, {
    projectId: input.projectId ?? undefined,
    type: MemoryType.SEMANTIC,
    source,
    content: input.content,
    provenance: input.source ?? `memorycoding.${input.level.toLowerCase()}`,
    structured: input.structured ?? null,
  });
  return { stored: true, memoryId: memory.id, source };
}
