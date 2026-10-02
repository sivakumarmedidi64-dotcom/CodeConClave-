/**
 * CodeConClave AI OS — P2.11 Workspace Context Sidebar.
 *
 * A read-only model of the current workspace/session context exposed to the
 * command palette / UI: current branch, changed files, open/edited files,
 * active skills, pending approvals, and stop-rule policy summary. It is a
 * READ MODEL: it never mutates files. Protected paths are surfaced as
 * "protected" (never their contents), honoring stop rules.
 */
import { AppError } from '../../shared/errors.js';
import type { P2Feature } from './flags.js';

export interface ContextPanel {
  workspaceId: string | null;
  branch: string | null;
  changedFiles: Array<{ path: string; protected: boolean }>;
  openFiles: string[];
  activeSkills: string[];
  pendingApprovals: string[];
  stopRules: {
    protectedPaths: string[];
    maxFilesChanged: number | null;
    maxRuntimeMs: number | null;
    allowDelete: boolean;
    approvalRequired: string[];
  };
}

export interface ContextSidebarInput {
  workspaceId: string | null;
  branch: string | null;
  changedFiles: string[];
  openFiles: string[];
  activeSkills: string[];
  pendingApprovals: string[];
}

export class ContextSidebar {
  constructor(
    private feature: () => P2Feature | null,
    private isProtected: (path: string) => boolean,
    private stopRuleSummary: () => {
      protectedPaths: string[];
      maxFilesChanged: number | null;
      maxRuntimeMs: number | null;
      allowDelete: boolean;
      approvalRequired: string[];
    },
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'context_sidebar';
  }

  present(input: ContextSidebarInput): ContextPanel {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_sidebar_disabled', 'context sidebar is off');
    return {
      workspaceId: input.workspaceId,
      branch: input.branch,
      changedFiles: input.changedFiles.map((path) => ({ path, protected: this.isProtected(path) })),
      openFiles: input.openFiles,
      activeSkills: input.activeSkills,
      pendingApprovals: input.pendingApprovals,
      stopRules: this.stopRuleSummary(),
    };
  }
}
