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

/** Browser control grant (P1) — which ops, on which origins, a device allows. */
export interface BrowserGrant {
  /** Optional label, e.g. "WebQA". */
  name: string;
  /** Subset of the 9 browser capabilities this device claims. */
  capabilities: string[];
  /**
   * Origin allowlist. `*` = public sites only (loopback/private/internal
   * targets are never reachable through a public grant). Equals treated as
   * scope bands; `http://127.0.0.1:*` matches that origin on any port.
   */
  allowedOrigins: string[];
}

/** Desktop control grant (P2) — which window/app ops a device allows. */
export interface DesktopGrant {
  /** Optional label, e.g. "Workstation". */
  name: string;
  /** Subset of `desktop.inspect`, `desktop.open_app`, `desktop.focus_window`. */
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
  /** Browser control grants the device advertises at register time (P1). */
  browser?: BrowserGrant[];
  /** Desktop control grants the device advertises at register time (P2). */
  desktop?: DesktopGrant[];
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
