/**
 * CodeConClave — Workspace Context Keeper (V4B).
 * Extends existing continuity (workspace_state, returnToWork, contextIndicator).
 * Persists developer's session state across devices and sessions.
 * Only persists state the application can actually observe.
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { cache } from '../../shared/cache.js';

export interface SessionContext {
  openProjectId: string | null;
  activeFiles: ActiveFile[];
  currentTaskId: string | null;
  activeAgentId: string | null;
  recentSearches: string[];
  recentCommands: string[];
  selectedBranch: string | null;
  lastActivityAt: Date;
  updatedAt: Date;
}

export interface ActiveFile {
  filePath: string;
  projectId: string;
  cursorPosition?: { line: number; column: number };
  lastViewedAt: Date;
}

export interface ContextPersistenceConfig {
  maxActiveFiles: number;
  maxRecentSearches: number;
  maxRecentCommands: number;
  retentionDays: number;
}

const DEFAULT_CONFIG: ContextPersistenceConfig = {
  maxActiveFiles: 10,
  maxRecentSearches: 20,
  maxRecentCommands: 30,
  retentionDays: 30,
};

const CONTEXT_KEY = 'session_context';

async function getSessionContext(userId: string): Promise<SessionContext | null> {
  const rows = await withTenant<{ value: SessionContext; updated_at: Date }[]>(userId, async (q) =>
    (
      await q.query<{ value: SessionContext; updated_at: Date }>(
        'SELECT value, updated_at FROM workspace_state WHERE owner_id = $1 AND key = $2',
        [userId, CONTEXT_KEY],
      )
    ).rows,
  );
  if (!rows[0]) return null;
  return rows[0].value;
}

async function setSessionContext(userId: string, context: SessionContext): Promise<void> {
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO workspace_state (id, owner_id, key, value, version)
       VALUES ($1,$2,$3,$4::jsonb, 1)
       ON CONFLICT (owner_id, key) DO UPDATE
         SET value = EXCLUDED.value, version = workspace_state.version + 1, updated_at = now()`,
      [newId(PREFIX.WORKSPACE), userId, CONTEXT_KEY, JSON.stringify(context)],
    ),
  );
}

export async function updateOpenProject(userId: string, projectId: string | null): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.openProjectId = projectId;
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function updateActiveFile(
  userId: string,
  file: { filePath: string; projectId: string; cursorPosition?: { line: number; column: number } }
): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  const existingIndex = context.activeFiles.findIndex(f => f.filePath === file.filePath && f.projectId === file.projectId);
  const activeFile: ActiveFile = {
    filePath: file.filePath,
    projectId: file.projectId,
    cursorPosition: file.cursorPosition,
    lastViewedAt: new Date(),
  };
  if (existingIndex >= 0) {
    context.activeFiles[existingIndex] = activeFile;
  } else {
    context.activeFiles.unshift(activeFile);
    if (context.activeFiles.length > DEFAULT_CONFIG.maxActiveFiles) {
      context.activeFiles = context.activeFiles.slice(0, DEFAULT_CONFIG.maxActiveFiles);
    }
  }
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function removeActiveFile(userId: string, filePath: string, projectId: string): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.activeFiles = context.activeFiles.filter(f => !(f.filePath === filePath && f.projectId === projectId));
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function setCurrentTask(userId: string, taskId: string | null): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.currentTaskId = taskId;
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function setActiveAgent(userId: string, agentId: string | null): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.activeAgentId = agentId;
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function addRecentSearch(userId: string, query: string): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.recentSearches = [query, ...context.recentSearches.filter(q => q !== query)].slice(0, DEFAULT_CONFIG.maxRecentSearches);
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function addRecentCommand(userId: string, command: string): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.recentCommands = [command, ...context.recentCommands.filter(c => c !== command)].slice(0, DEFAULT_CONFIG.maxRecentCommands);
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function setSelectedBranch(userId: string, branch: string | null): Promise<SessionContext> {
  const context = await getSessionContext(userId) ?? getEmptyContext();
  context.selectedBranch = branch;
  context.lastActivityAt = new Date();
  await setSessionContext(userId, context);
  return context;
}

export async function getSessionContextForUser(userId: string): Promise<SessionContext> {
  const context = await getSessionContext(userId);
  return context ?? getEmptyContext();
}

export async function clearSessionContext(userId: string): Promise<void> {
  await withTenant(userId, (q) => q.query('DELETE FROM workspace_state WHERE owner_id = $1 AND key = $2', [userId, CONTEXT_KEY]));
}

function getEmptyContext(): SessionContext {
  return {
    openProjectId: null,
    activeFiles: [],
    currentTaskId: null,
    activeAgentId: null,
    recentSearches: [],
    recentCommands: [],
    selectedBranch: null,
    lastActivityAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function cleanupOldContexts(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DEFAULT_CONFIG.retentionDays);
  const result = await pool.query(
    `DELETE FROM workspace_state WHERE key = $1 AND updated_at < $2`,
    [CONTEXT_KEY, cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function exportSessionContext(userId: string): Promise<SessionContext | null> {
  return getSessionContext(userId);
}

export async function importSessionContext(userId: string, context: SessionContext): Promise<SessionContext> {
  const sanitized = {
    openProjectId: context.openProjectId,
    activeFiles: context.activeFiles?.slice(0, DEFAULT_CONFIG.maxActiveFiles) ?? [],
    currentTaskId: context.currentTaskId ?? null,
    activeAgentId: context.activeAgentId ?? null,
    recentSearches: context.recentSearches?.slice(0, DEFAULT_CONFIG.maxRecentSearches) ?? [],
    recentCommands: context.recentCommands?.slice(0, DEFAULT_CONFIG.maxRecentCommands) ?? [],
    selectedBranch: context.selectedBranch ?? null,
    lastActivityAt: new Date(context.lastActivityAt ?? Date.now()),
    updatedAt: new Date(),
  };
  await setSessionContext(userId, sanitized);
  return sanitized;
}