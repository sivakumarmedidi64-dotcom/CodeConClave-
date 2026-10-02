/**
 * CodeConClave — PKG-24 AI Developer Copilot — memory feedback loop.
 *
 * After an approved/reviewed copilot action the frontend may record a bounded,
 * non-sensitive learning signal (accepted suggestion, rejected suggestion,
 * correction, test passed/failed, preferred pattern). This reuses the PKG-23
 * feedback lifecycle: OBSERVED/CONFIRMED/EXPLICIT persist; INFERRED is never
 * stored. Conversations and generated answers are NOT auto-persisted as memory.
 */
import { learnFromFeedback } from '../memorycoding/feedback.js';
import type { FeedbackLevel } from '../memorycoding/feedback.js';

export type CopilotFeedbackLevel = FeedbackLevel;

export interface CopilotFeedbackInput {
  projectId?: string | null;
  content: string;
  level: CopilotFeedbackLevel;
  source?: string;
  structured?: Record<string, unknown>;
}

export interface CopilotFeedbackResult {
  stored: boolean;
  reason?: string;
  memoryId?: string;
  source?: string;
}

/**
 * Record a learning signal through the PKG-23 feedback loop. Emits only tiny
 *, non-sensitive signals (e.g. "user accepted suggestion X"), never raw
 * conversations or full generated answers.
 */
export async function copilotFeedback(
  userId: string,
  input: CopilotFeedbackInput,
): Promise<CopilotFeedbackResult> {
  const signal = {
    projectId: input.projectId ?? null,
    content: input.content.slice(0, 500),
    level: input.level,
    source: input.source ?? 'copilot',
    structured: input.structured ?? {},
  };
  const result = (await learnFromFeedback(userId, signal)) as CopilotFeedbackResult;
  return result;
}
