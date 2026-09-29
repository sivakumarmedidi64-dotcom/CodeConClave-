/**
 * CodeConClave Desktop — preload bridge contract (THE renderer-facing API).
 *
 * This interface, and ONLY this interface, crosses the context-isolation
 * boundary. It has no generic `invoke(channel, ...)` and no `send(channel ...)`
 * escape hatch: every method is a fixed channel with a fixed capability label
 * (see `ipc/channels.ts`). The renderer therefore cannot request capabilities
 * it was not granted, cannot reach unlisted channels, and cannot touch Node.
 */
import type {
  AttachResult,
  ConnectionStatus,
  CoworkResumeResult,
  DesktopEventName,
  EditResult,
  EntitlementRead,
  FileDiffResult,
  FileListEntry,
  FileMetadataResult,
  FileReadResult,
  GitDiffResult,
  GitStatusResult,
  TaskSummary,
  TerminalSessionSummary,
  TerminalWriteResult,
  UndoItem,
  UndoRollbackResult,
  WorkspaceSettings,
  WorkspaceSummary,
} from '../types.js';

export interface EntitlementStatus {
  authed: boolean;
  planId: string | null;
  entitlementState: string | null;
  online: boolean;
}

export interface DesktopSurface {
  readonly platform: NodeJS.Platform;
  readonly versions: { app: string; electron: boolean };
  readonly auth: {
    status(): Promise<EntitlementStatus>;
    entitlement(): Promise<EntitlementRead>;
  };
  readonly workspace: {
    list(): Promise<WorkspaceSummary[]>;
    open(root: string): Promise<WorkspaceSummary>;
    detect(): Promise<WorkspaceSummary[]>;
  };
  readonly files: {
    list(relPath?: string): Promise<{ entries: FileListEntry[]; error?: string }>;
    read(relPath: string): Promise<FileReadResult>;
    metadata(relPath: string): Promise<FileMetadataResult>;
    diff(relPath: string, content: string): Promise<FileDiffResult>;
    write(relPath: string, content: string): Promise<EditResult>;
    attach(paths: string[]): Promise<AttachResult>;
    drop(paths: string[]): Promise<AttachResult>;
  };
  readonly undo: {
    list(): Promise<UndoItem[]>;
    rollback(id: string): Promise<UndoRollbackResult>;
  };
  readonly terminal: {
    open(shell: string, cwd: string): Promise<TerminalSessionSummary>;
    write(tabId: string, line: string): Promise<TerminalWriteResult>;
    kill(tabId: string): Promise<void>;
    list(): Promise<TerminalSessionSummary[]>;
  };
  readonly git: {
    status(): Promise<GitStatusResult>;
    diff(relPath?: string): Promise<GitDiffResult>;
  };
  readonly task: {
    list(): Promise<TaskSummary[]>;
  };
  readonly reconnect: {
    status(): Promise<ConnectionStatus>;
    reconnect(): Promise<ConnectionStatus>;
  };
  readonly cowork: {
    resume(sessionId: string): Promise<CoworkResumeResult>;
  };
  readonly settings: {
    read(): Promise<WorkspaceSettings>;
    setTheme(theme: 'light' | 'dark' | 'system'): Promise<WorkspaceSettings>;
  };
  readonly voice: {
    /** Honest desktop voice support report (browser Web Speech presence only). */
    support(): Promise<{ recognition: string; synthesis: string }>;
  };
  readonly teamCollab: {
    /** Honest desktop team-collaboration support/connectivity report. */
    support(): Promise<{
      available: boolean;
      source: 'backend' | 'desktop-report';
      capabilities: string[];
    }>;
    /** Read-only presence snapshot for a team (canonical, server-confirmed). */
    presence(teamId: string): Promise<{ onlineCount: number; presence: Array<{ userId: string; state: string; at: number }> }>;
    /** Read-only visible team skills (non-private only). */
    skills(teamId: string): Promise<Array<{ id: string; name: string; visible: boolean }>>;
    /** Read-only collaboration queue for a team. */
    queue(teamId: string): Promise<Array<{ id: string; title: string; status: string; assigneeId: string | null }>>;
  };
  readonly screen: {
    /** Capture screen as PNG/JPEG bytes. Requires desktop app. */
    capture(options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array | null>;
    /** List available capture sources (screens, windows). */
    sources(): Promise<Array<{ id: string; name: string; display_id?: string; thumbnail: { width: number; height: number } }>>;
  };

  /** Subscribe to allow-listed events only; returns an unsubscribe function. */
  readonly monitor: {
    subscribe(cb: (msg: { name: DesktopEventName; payload: unknown }) => void): Promise<() => void>;
  };
}

export interface DesktopBridge {
  isDesktopBridge: true;
  desktop: DesktopSurface;
}