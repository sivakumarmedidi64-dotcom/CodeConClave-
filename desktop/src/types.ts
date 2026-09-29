/**
 * CodeConClave Desktop — shared domain types.
 * These types cross the main↔renderer boundary (via the preload bridge) and are
 * intentionally secret-safe: no tokens, credentials, provider payloads, or raw
 * secrets ever appear.
 */

export type CapabilityId =
  | 'workspace.read'
  | 'workspace.switch'
  | 'files.read'
  | 'files.write'
  | 'files.attach'
  | 'terminal.run'
  | 'terminal.write'
  | 'git.read'
  | 'undo.rollback'
  | 'task.monitor'
  | 'entitlement.read'
  | 'cowork.resume'
  | 'reconnect.control'
  | 'voice.control'
  | 'team.collaboration'
  | 'screen.capture';

export const CAPABILITY_IDS: readonly CapabilityId[] = [
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
  'voice.control',
  'team.collaboration',
  'screen.capture',
] as const;

export type EntitlementState = 'FREE' | 'PRO_PENDING' | 'PRO_VERIFIED' | 'PRO_EXPIRED' | 'PRO_REFUNDED' | 'UNKNOWN';

export interface EntitlementRead {
  online: boolean;
  authed: boolean;
  planId: 'free' | 'pro' | 'team' | 'enterprise' | null;
  entitlementState: EntitlementState;
}

export interface WorkspaceSummary {
  root: string;
  name: string;
  active: boolean;
  exists: boolean;
  capabilities: CapabilityId[];
}

export interface FileListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileReadResult {
  ok: boolean;
  error?: string;
  content?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface EditResult {
  ok: boolean;
  error?: string;
  path?: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  backupPath?: string;
}

export interface FileMetadataResult {
  ok: boolean;
  error?: string;
  path?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  isDirectory?: boolean;
  name?: string;
}

/** Preview of an edit WITHOUT touching the file (diff + hashes only). */
export interface FileDiffResult {
  ok: boolean;
  error?: string;
  path?: string;
  allowed?: boolean;
  risk?: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
}

export interface AttachResult {
  accepted: number;
  rejected: Array<{ path: string; reason: string }>;
}

export interface DropResult extends AttachResult {}

export interface UndoItem {
  id: string;
  path: string;
  beforeHash: string;
  backupPath: string;
  createdAt: string;
}

export interface UndoRollbackResult {
  ok: boolean;
  error?: string;
}

export type TerminalStatus = 'PLANNED' | 'STARTING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'KILLED' | 'TIMED_OUT';

export interface TerminalSessionSummary {
  tabId: string;
  shell: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
}

export interface TerminalWriteResult {
  accepted: boolean;
  reason?: string;
}

export type GitStatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  kind: GitStatusKind;
  path: string;
}

export interface GitStatusResult {
  ok: boolean;
  error?: string;
  branch: string | null;
  clean: boolean;
  files: GitFileStatus[];
}

export interface GitDiffResult {
  ok: boolean;
  error?: string;
  diff: string;
  truncated: boolean;
}

export interface TaskSummary {
  id: string;
  kind: 'terminal' | 'git' | 'add';
  label: string;
  status: TerminalStatus | 'SUCCEEDED' | 'FAILED' | 'RUNNING';
  startedAt: string;
}

export interface ConnectionStatus {
  online: boolean;
  attempts: number;
  lastError: string | null;
  reconnecting: boolean;
}

export interface CoworkResumeResult {
  ok: boolean;
  error?: string;
  resumed: boolean;
  cursor: number;
  changed: boolean;
}

export interface WorkspaceSettings {
  appUrl: string;
  activeRoot: string | null;
  ui: {
    theme: 'light' | 'dark' | 'system';
    fontScale: number;
  };
}

/** Fixed, allow-listed event names the renderer may subscribe to. */
export const DESKTOP_EVENTS = [
  'connection',
  'workspace',
  'terminal',
  'task',
  'workspace-file-change',
] as const;

export type DesktopEventName = (typeof DESKTOP_EVENTS)[number];

export type FileChangeKind = 'created' | 'changed' | 'removed' | 'renamed' | 'unknown';

export interface FileChange {
  wsRoot: string;
  path: string;
  kind: FileChangeKind;
  at: string;
}

/**
 * Screen capture foundation (local desktop only).
 * The renderer never receives raw capture; it only gets the result via preload.
 */
export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenCaptureOptions {
  displayId?: string;
  windowId?: number;
  region?: ScreenshotRegion;
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface CaptureResult {
  image: Uint8Array;
  format: string;
  width: number;
  height: number;
  timestamp: string;
  displayId?: string;
  windowId?: number;
}

export interface ScreenshotSource {
  readonly name: string;
  readonly available: boolean;
  capture(deviceId: string, sessionId: string): Promise<Uint8Array | null>;
  captureWithOptions(deviceId: string, sessionId: string, options: ScreenCaptureOptions): Promise<CaptureResult | null>;
}

export class UnavailableScreenshotSource implements ScreenshotSource {
  readonly name = 'unavailable';
  readonly available = false;

  async capture(): Promise<Uint8Array | null> {
    return null;
  }

  async captureWithOptions(): Promise<CaptureResult | null> {
    return null;
  }
}

/**
 * PKG-10 Voice — honest desktop voice support result.
 * Reports whether the desktop renderer can use the BROWSER Web Speech API.
 * It is never a provider-backed STT/TTS claim and never exposes raw mic audio,
 * node, fs, child_process, env, or secrets to the renderer.
 */
export type VoiceSupportStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'PERMISSION_DENIED' | 'ERROR';

export interface VoiceSupport {
  recognition: VoiceSupportStatus;
  synthesis: VoiceSupportStatus;
}