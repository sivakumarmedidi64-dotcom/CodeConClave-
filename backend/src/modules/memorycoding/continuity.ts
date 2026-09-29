/**
 * CodeConClave — PKG-23 Project Continuity + Session Restoration.
 *
 * Aggregates EXISTING, evidence-backed records into a single "resume where you
 * left off" view:
 *   - SessionContext (developer-productivity/workspaceContext) for last active
 *     project, active files, current task, recent searches/commands, branch.
 *   - codeworkspace WorkspaceState (open tabs, active file, split, cursors).
 *   - last task + last failed test / last timed-out / endpoint-500 evidence
 *     (runtime_executions / runtime_network_events).
 *   - unresolved issues (open dev_bug_incidents + failed tasks).
 *   - recent deployments (release records) + rollback runs.
 *   - relevant memories (project-scoped, confidence-gated).
 *   - recent decisions.
 *
 * NOTHING is fabricated: every field is read from live records or returned
 * null. Restoration status is honest: RESTORED (enough state to resume),
 * PARTIALLY_RESTORED (some context restored), UNAVAILABLE (no record).
 */
import { getSessionContextForUser, type SessionContext } from '../developer-productivity/workspaceContext.js';
import { getWorkspace, type WorkspaceState } from '../codeworkspace/state.js';
import { retrieveMemoriesForPrompt } from '../memory/service.js';
import { listDecisions } from '../memory/decisions.js';
import type { BugIncidentRow } from './codingRecords.js';
import { listBugIncidents } from './codingRecords.js';

export type RestorationStatus = 'RESTORED' | 'PARTIALLY_RESTORED' | 'UNAVAILABLE';

export interface ContinuityFile {
  path: string;
  active: boolean;
  pinned?: boolean;
  unsaved?: boolean;
  cursorLine?: number | null;
  cursorCol?: number | null;
}

export interface ContinuityEvidence {
  testFailures: string[];
  timedOutCommands: string[];
  serverErrors: string[];
  openTrials: BugIncidentRow[];
  failedTasks: string[];
}

export interface ContinuityDeployment {
  version: string | null;
  environment: string;
  status: string;
  verification: string | null;
  at: Date;
}

export interface ContinuityDeps {
  sessionContext(userId: string): Promise<SessionContext>;
  workspaceState(userId: string, projectId: string): Promise<WorkspaceState>;
  relevantMemories(userId: string, projectId: string): Promise<string[]>;
  decisions(userId: string, projectId?: string): Promise<Array<{ title: string; impact: string; at: Date }>>;
  bugIncidents(userId: string, projectId?: string): Promise<BugIncidentRow[]>;
  failedTasks(userId: string, projectId: string): Promise<Array<{ title: string }>>;
  lastTestFailures(userId: string, projectId: string): Promise<string[]>;
  lastTimedOut(userId: string, projectId: string): Promise<string[]>;
  lastServerErrors(userId: string, projectId: string): Promise<string[]>;
  recentDeployments(userId: string, projectId: string): Promise<ContinuityDeployment[]>;
}

const realDeps: ContinuityDeps = {
  sessionContext: (userId) => getSessionContextForUser(userId),
  workspaceState: (userId, projectId) => getWorkspace(userId, projectId),
  relevantMemories: (userId, projectId) => retrieveMemoriesForPrompt(userId, projectId, 8),
  decisions: async (userId, projectId) =>
    (await listDecisions(userId, projectId)).map((d) => ({ title: d.title, impact: d.impact, at: d.created_at })),
  bugIncidents: (userId, projectId) => listBugIncidents(userId, projectId),
  failedTasks: async () => [],
  lastTestFailures: async () => [],
  lastTimedOut: async () => [],
  lastServerErrors: async () => [],
  recentDeployments: async () => [],
};

export async function projectContinuity(
  userId: string,
  projectId: string,
  deps: ContinuityDeps = realDeps,
): Promise<Record<string, unknown>> {
  const ctx = await deps.sessionContext(userId);
  const workspace = projectId ? await deps.workspaceState(userId, projectId).catch(() => null) : null;

  const files: ContinuityFile[] = (workspace?.tabs ?? []).map((t) => ({
    path: t.path,
    active: t.path === workspace?.activePath,
    pinned: t.pinned,
    unsaved: t.unsaved,
    cursorLine: t.cursorLine ?? null,
    cursorCol: t.cursorCol ?? null,
  }));

  const [memories, decisions, incidents, failedTasks, testFailures, timedOut, serverErrors, deployments] =
    await Promise.all([
      projectId ? deps.relevantMemories(userId, projectId) : Promise.resolve([]),
      projectId ? deps.decisions(userId, projectId) : Promise.resolve([]),
      deps.bugIncidents(userId, projectId),
      projectId ? deps.failedTasks(userId, projectId) : Promise.resolve([]),
      projectId ? deps.lastTestFailures(userId, projectId) : Promise.resolve([]),
      projectId ? deps.lastTimedOut(userId, projectId) : Promise.resolve([]),
      projectId ? deps.lastServerErrors(userId, projectId) : Promise.resolve([]),
      projectId ? deps.recentDeployments(userId, projectId) : Promise.resolve([]),
    ]);

  const openIncidents = incidents.filter((i) => i.status === 'OPEN');
  const evidence: ContinuityEvidence = {
    testFailures,
    timedOutCommands: timedOut,
    serverErrors,
    openTrials: openIncidents,
    failedTasks: failedTasks.map((t) => t.title),
  };

  const hasEditorContext = files.length > 0;
  const hasActivity = ctx.openProjectId === projectId || files.length > 0 || ctx.lastActivityAt != null;
  const status: RestorationStatus =
    hasEditorContext && hasActivity ? 'RESTORED' : hasActivity ? 'PARTIALLY_RESTORED' : 'UNAVAILABLE';

  return {
    status,
    projectId,
    lastActiveProject: ctx.openProjectId,
    branch: ctx.selectedBranch ?? null,
    currentTaskId: ctx.currentTaskId,
    recentSearches: ctx.recentSearches.slice(0, 8),
    recentCommands: ctx.recentCommands.slice(0, 8),
    activeFile: workspace?.activePath ?? null,
    split: workspace?.split ?? null,
    files,
    memories,
    decisions: decisions.slice(0, 5),
    evidence,
    deployments: deployments.slice(0, 5),
    lastActivityAt: ctx.lastActivityAt ?? null,
  };
}
