/**
 * Shared test helpers for the desktop workspace package.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from './workspace.js';
import type { CapabilityId } from '../types.js';

export const ALL_CAPABILITIES: readonly CapabilityId[] = [
  'workspace.read',
  'workspace.switch',
  'files.read',
  'files.write',
  'files.attach',
  'terminal.run',
  'terminal.write',
  'git.read',
  'undo.rollback',
  'task.monitor',
  'entitlement.read',
  'cowork.resume',
  'reconnect.control',
];

export function makeWorkspace(opts: { dir?: string; capabilities?: readonly CapabilityId[] } = {}): WorkspaceManager {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'cc-ws-'));
  const capabilities = [...(opts.capabilities ?? ALL_CAPABILITIES)];
  return new WorkspaceManager(
    () => [{ root: dir, name: dir, capabilities }],
    {
      activeRoot: () => dir,
      setActiveRoot: () => undefined,
    },
  );
}