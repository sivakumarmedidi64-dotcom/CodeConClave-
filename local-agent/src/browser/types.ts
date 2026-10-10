/** Shared browser types. */
import type { ChildProcess } from 'node:child_process';
import type { CdpSession } from './cdp.js';

/** A CodeConClave-managed browser session (Mode 1). */
export interface ManagedBrowser {
  process: ChildProcess;
  browserWsUrl: string;
  pageId: string;
  pageWsUrl: string;
  session: CdpSession;
  cleanup(): Promise<void>;
}

/** Normalized, resolved action result the task bridge reports. */
export interface ActionResult {
  ok: boolean;
  /** Structured, redacted summary for progress/result payloads. */
  summary: Record<string, unknown>;
  /** Full error string when ok is false (redacted). */
  error?: string;
  /** Artifact produced by this action (e.g. a screenshot file). */
  artifact?: { path: string; absPath: string; bytes: number; sha256: string };
}