/**
 * CodeConClave Desktop — terminal host (local).
 * Real shells via the local-agent TerminalSession (foundation), with an
 * optional node-pty upgrade path. EVERY line typed into a session passes
 * through the local-agent `gateTerminalInput` policy (CRITICAL/HIGH denied;
 * unknown commands denied by default) BEFORE reaching the real process. This
 * is the same deny-by-default gate the local-agent CLI enforces.
 */
import { gateTerminalInput } from '@codeconclave/local-agent/policy';
import type { TerminalSessionSummary, TerminalWriteResult } from '../types.js';
import { WorkspaceManager, CapabilityError } from './workspace.js';

export interface SessionLike {
  readonly tabId: string;
  readonly shell: string;
  readonly cwd: string;
  start(): { ok: boolean; error?: string };
  write(data: string): void;
  stop(): void;
  getStatus(): { status: string; exitCode: number | null };
}

export type SessionFactory = (tabId: string, shell: string, cwd: string) => SessionLike;

export interface TerminalEvents {
  onOutput: (tabId: string, channel: 'stdout' | 'stderr', text: string) => void;
  onStatus: (tabId: string, status: string, exitCode: number | null) => void;
}

export const ALLOWED_SHELLS = new Set(['bash', 'zsh', 'node', 'python', 'powershell']);

export class TerminalHost {
  private readonly sessions = new Map<string, SessionLike>();

  constructor(
    private readonly ws: WorkspaceManager,
    private readonly events: TerminalEvents,
    private readonly factory: SessionFactory,
  ) {}

  open(shell: string, cwd: string): TerminalSessionSummary {
    if (!ALLOWED_SHELLS.has(shell)) throw new CapabilityError('terminal.run: shell not allowed');
    const grant = this.ws.requireActive('terminal.run');
    this.ws.requireCapability(grant, 'files.read'); // cwd must be a readable workspace path
    const resolved = this.ws.resolveActive(cwd);
    const absCwd = resolved.ok ? resolved.abs : grant.root;
    const tabId = `tab-${Math.random().toString(36).slice(2, 10)}`;
    const session = this.factory(tabId, shell, absCwd);
    session.start();
    this.sessions.set(tabId, session);
    return this.summary(session);
  }

  write(tabId: string, line: string): TerminalWriteResult {
    const grant = this.ws.requireActive('terminal.write');
    this.ws.requireCapability(grant, 'terminal.write');
    const session = this.sessions.get(tabId);
    if (!session) return { accepted: false, reason: 'session not found' };
    const decision = gateTerminalInput(line);
    if (!decision.allowed) return { accepted: false, reason: decision.reason };
    session.write(`${line}\n`);
    return { accepted: true };
  }

  kill(tabId: string): void {
    const session = this.sessions.get(tabId);
    this.ws.requireActive('terminal.write');
    if (session) session.stop();
  }

  list(): TerminalSessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  getStatusOf(tabId: string): TerminalSessionSummary | null {
    const s = this.sessions.get(tabId);
    return s ? this.summary(s) : null;
  }

  private summary(s: SessionLike): TerminalSessionSummary {
    const st = s.getStatus();
    return {
      tabId: s.tabId,
      shell: s.shell,
      cwd: s.cwd,
      status: st.status as TerminalSessionSummary['status'],
      exitCode: st.exitCode,
    };
  }
}