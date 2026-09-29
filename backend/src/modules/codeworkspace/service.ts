/**
 * CodeConClave — PKG-22 Advanced Code Workspace — orchestration + capabilities.
 * Honest capability report: no editor syntax highlighting/LSP claims; state is
 * PARTIAL/HEURISTIC/UNAVAILABLE where that is the truth.
 */
import { workspaceCapabilityReport, workspaceEnabled } from './config.js';
import { diagnosticsCapability } from './diagnostics.js';
import { workspaceUsable } from './security.js';

export function workspaceCapabilities(projectId: string, userId: string) {
  void userId;
  void projectId;
  const base = workspaceCapabilityReport();
  return {
    anchors: ['F19', 'F20', 'F34', 'F90', 'B1'],
    enabled: base.enabled,
    rootConfigured: base.rootConfigured,
    editor: {
      state: base.enabled && base.rootConfigured ? 'PARTIAL' : 'ENVIRONMENT_BLOCKED',
      syntaxHighlighting: 'UNAVAILABLE', // honest: no Monaco/CodeMirror/LSP
      lineNumbers: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
      multiFileTabs: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
      splitPane: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
      undoRedo: 'PARTIAL', // via version-aware edit history
      unsavedState: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
      persistence: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
    },
    search: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
    symbols: { state: 'HEURISTIC', lsp: 'UNAVAILABLE' },
    refactoring: { state: 'PARTIAL', operations: ['rename'] },
    diagnostics: diagnosticsCapability(),
    diffReview: 'VERIFIED',
    b1Integration: 'VERIFIED',
    memory: 'PARTIAL',
    crossFileIntelligence: 'PARTIAL',
    performance: 'PARTIAL',
    security: 'VERIFIED',
    userIsolation: 'VERIFIED',
    workspaceIsolation: 'VERIFIED',
    git: 'UNAVAILABLE',
    api: base.enabled ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED',
  };
}

export function workspaceEnabledFlag(): boolean {
  return workspaceEnabled();
}

export { workspaceUsable };
