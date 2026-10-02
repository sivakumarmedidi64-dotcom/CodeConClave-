/**
 * CodeConClave — PKG-22 Advanced Code Workspace — config.
 * Feature-gated (AIOS_P2_WORKSPACE, default OFF and reversible). When OFF, the
 * workspace surfaces report UNAVAILABLE and no route mutates anything.
 */
import { env } from '../../config/env.js';

export function workspaceEnabled(): boolean {
  return env.AIOS_P2_WORKSPACE === 'true';
}

/** Max bytes of a single text file the workspace will open (large-file guard). */
export function maxFileBytes(): number {
  return 2 * 1024 * 1024; // 2 MiB — beyond this the file is reported LARGE, never force-loaded
}

/** Max search results per request (bounded memory). */
export function maxSearchResults(): number {
  return 500;
}

/** Max bytes of content scanned per search query across all files (bounded memory). */
export function maxSearchScanBytes(): number {
  return 32 * 1024 * 1024; // 32 MiB wall — cancel rather than blow memory
}

/** Max context bytes assembled for an AI editor-context payload. */
export function maxContextBytes(): number {
  return 64 * 1024; // 64 KiB bounded context
}

export function workspaceCapabilityReport() {
  return {
    anchors: ['F19', 'F20', 'F34', 'F90', 'B1'],
    enabled: workspaceEnabled(),
    rootConfigured: Boolean(env.PREVIEW_PROJECTS_ROOT),
  };
}
