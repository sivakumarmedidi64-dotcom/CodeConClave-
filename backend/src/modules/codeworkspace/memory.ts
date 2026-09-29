/**
 * CodeConClave — PKG-22 Advanced Code Workspace — memory integration.
 * Workspace-scoped, permission-aware, non-destructive memory recall. Suggestions
 * are advisory only; never auto-applied, never cross-tenant.
 */
import { workspaceEnabled } from './config.js';
import { AppError } from '../../shared/errors.js';
import { retrieveMemoriesForPrompt } from '../memory/service.js';

export async function retrieveWorkspaceMemory(userId: string, projectId: string, _relPath?: string): Promise<string[]> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  // retrieveMemoriesForPrompt is project-scoped and permission-aware (only the
  // requesting user's own memories; non-destructive read). Explanable: the
  // returned strings carry no unrelated memories.
  const memories = await retrieveMemoriesForPrompt(userId, projectId, 5).catch(() => []);
  return memories.slice(0, 5);
}

export async function workspaceMemoryContext(userId: string, projectId: string): Promise<{ present: boolean; suggestions: string[] }> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const suggestions = await retrieveWorkspaceMemory(userId, projectId);
  return { present: suggestions.length > 0, suggestions };
}
