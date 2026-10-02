/**
 * CodeConClave Local Agent — configuration.
 * Stored in ~/.codeconclave/agent.json (mode 0600). The device secret is
 * displayed once at init and never persisted; the pairing token IS persisted
 * because it is the long-lived /agent WS credential (hashed on the server).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const VERSION = '0.1.0';
export const CONFIG_DIR = join(homedir(), '.codeconclave');
export const CONFIG_FILE = join(CONFIG_DIR, 'agent.json');

export interface WorkspaceGrant {
  /** Absolute root path of the authorized workspace (must exist). */
  root: string;
  /** Optional label, e.g. "MyProject". */
  name: string;
  /** Allowed operations inside this root (subset of capability ids). */
  capabilities: string[];
}

export interface AgentConfig {
  version: string;
  deviceId: string;
  deviceSecretHash: string;
  createdAt: string;
  pairedTo?: string;
  backendUrl?: string;
  token?: string;
  workspaces?: WorkspaceGrant[];
}

export function loadConfig(): AgentConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function workspaceRoots(config: AgentConfig): string[] {
  return (config.workspaces ?? []).map((w) => w.root);
}

export function grantFor(config: AgentConfig, root: string): WorkspaceGrant | undefined {
  return (config.workspaces ?? []).find((w) => w.root === root);
}
