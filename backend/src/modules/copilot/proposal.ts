/**
 * CodeConClave — PKG-24 AI Developer Copilot — safe AI change application.
 *
 * When a copilot suggests a code change it is surfaced as a B1 REVIEW proposal
 * through the existing reviews module. Nothing is applied automatically: the
 * user reviews the diff, accepts/rejects what they choose, then applies through
 * the normal B1 apply → test → undo → commit flow. This module never edits
 * source directly and never creates a second approval authority.
 */
import { createReview } from '../reviews/service.js';
import type { ReviewView } from '../reviews/types.js';

export interface CopilotSourceEdit {
  path: string;
  proposedContent: string;
  summary: string;
}

export interface CopilotProposalDeps {
  createReview(
    userId: string,
    projectId: string,
    input: Parameters<typeof createReview>[2],
  ): Promise<ReviewView>;
}

/**
 * Turn an AI-generated change set into a B1 review. Returns the ReviewView for
 * the user to review/apply. NEVER applies automatically. `taskId` is required
 * (consistent with the B1 review contract).
 */
export async function proposeChangeViaB1(
  userId: string,
  projectId: string,
  taskId: string,
  edits: CopilotSourceEdit[],
  title: string,
  deps: CopilotProposalDeps = { createReview },
): Promise<ReviewView> {
  if (!edits.length) throw new Error('No edits proposed');
  const files = edits.map((e) => ({
    path: e.path,
    proposedContent: e.proposedContent,
  }));
  return deps.createReview(userId, projectId, {
    taskId,
    title,
    files,
  });
}
