/**
 * CodeConClave Desktop — IPC channel allow-list (THE surface contract).
 *
 * The renderer-facing preload API is built ONLY from this table. There is no
 * generic `invoke(channel, ...)` escape hatch: every exposed method maps to a
 * fixed channel, with a fixed capability label and a fixed payload validator.
 * Unknown channels, unknown fields, and wrong payload types are rejected at
 * the boundary. Adding a feature means adding a row here AND a preload method —
 * never a passthrough.
 */
import type { CapabilityId } from '../types.js';

export type IpcChannelName = `cc:${string}`;

export class IpcPayloadError extends Error {
  readonly code = 'invalid_ipc_payload';
  constructor(message: string) {
    super(message);
    this.name = 'IpcPayloadError';
  }
}

/** Strict-ish payload guards (no schema library; hand-rolled, deterministic). */
export function str(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || v.length > max) throw new IpcPayloadError('expected string');
  return v;
}

export function optStr(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  return str(v);
}

export function id(v: unknown): string {
  const s = str(v);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new IpcPayloadError('invalid identifier');
  return s;
}

export function num(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new IpcPayloadError('invalid number');
  return v;
}

export interface ChannelDef {
  channel: IpcChannelName;
  capability: CapabilityId;
  /** Expected payload shape. Validators must throw IpcPayloadError. */
  validate: (payload: unknown) => unknown;
}

/** Every channel that exists in the app. The preload may only reference these. */
export const CHANNELS: readonly ChannelDef[] = [
  { channel: 'cc:entitlement:read', capability: 'entitlement.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:auth:status', capability: 'entitlement.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:workspace:list', capability: 'workspace.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:workspace:open', capability: 'workspace.switch', validate: (p) => ({ root: str(p && (p as { root?: unknown }).root, 1024) }) },
  { channel: 'cc:workspace:detect', capability: 'workspace.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:files:list', capability: 'files.read', validate: (p) => ({ relPath: optStr(p && (p as { relPath?: unknown }).relPath) }) },
  { channel: 'cc:files:read', capability: 'files.read', validate: (p) => ({ relPath: str(p && (p as { relPath?: unknown }).relPath, 1024) }) },
  { channel: 'cc:files:metadata', capability: 'files.read', validate: (p) => ({ relPath: str(p && (p as { relPath?: unknown }).relPath, 1024) }) },
  { channel: 'cc:files:diff', capability: 'files.write', validate: (p) => ({ relPath: str(p && (p as { relPath?: unknown }).relPath, 1024), content: str((p && (p as { content?: unknown }).content), 2_000_000) }) },
  { channel: 'cc:files:write', capability: 'files.write', validate: (p) => ({ relPath: str(p && (p as { relPath?: unknown }).relPath, 1024), content: str((p && (p as { content?: unknown }).content), 2_000_000) }) },
  { channel: 'cc:files:attach', capability: 'files.attach', validate: (p) => {
      const paths = (p && (p as { paths?: unknown }).paths) ?? [];
      if (!Array.isArray(paths) || paths.length > 50) throw new IpcPayloadError('attach paths invalid');
      return { paths: paths.map((x) => str(x, 1024)) };
    } },
  { channel: 'cc:files:drop', capability: 'files.attach', validate: (p) => {
      const paths = (p && (p as { paths?: unknown }).paths) ?? [];
      if (!Array.isArray(paths) || paths.length > 50) throw new IpcPayloadError('drop paths invalid');
      return { paths: paths.map((x) => str(x, 1024)) };
    } },
  { channel: 'cc:undo:list', capability: 'undo.rollback', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:undo:rollback', capability: 'undo.rollback', validate: (p) => ({ id: id(p && (p as { id?: unknown }).id) }) },
  { channel: 'cc:terminal:open', capability: 'terminal.run', validate: (p) => ({ shell: str((p && (p as { shell?: unknown }).shell) ?? 'bash', 32), cwd: str((p && (p as { cwd?: unknown }).cwd) ?? '.', 1024) }) },
  { channel: 'cc:terminal:write', capability: 'terminal.write', validate: (p) => ({ tabId: id(p && (p as { tabId?: unknown }).tabId), line: str((p && (p as { line?: unknown }).line) ?? '', 8192) }) },
  { channel: 'cc:terminal:kill', capability: 'terminal.write', validate: (p) => ({ tabId: id(p && (p as { tabId?: unknown }).tabId) }) },
  { channel: 'cc:terminal:list', capability: 'terminal.run', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:git:status', capability: 'git.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:git:diff', capability: 'git.read', validate: (p) => ({ relPath: optStr(p && (p as { relPath?: unknown }).relPath) }) },
  { channel: 'cc:task:list', capability: 'task.monitor', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:reconnect:status', capability: 'reconnect.control', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:reconnect:now', capability: 'reconnect.control', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:cowork:resume', capability: 'cowork.resume', validate: (p) => ({ sessionId: id(p && (p as { sessionId?: unknown }).sessionId) }) },
  { channel: 'cc:settings:read', capability: 'workspace.read', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:settings:ui', capability: 'workspace.read', validate: (p) => ({ theme: str(((p && (p as { theme?: unknown }).theme) ?? 'system') as string, 16) }) },
  { channel: 'cc:monitor:subscribe', capability: 'task.monitor', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:voice:support', capability: 'voice.control', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:teamcollab:support', capability: 'team.collaboration', validate: (p) => (p === undefined ? {} : {}) },
  { channel: 'cc:teamcollab:presence', capability: 'team.collaboration', validate: (p) => ({ teamId: id(p && (p as { teamId?: unknown }).teamId) }) },
  { channel: 'cc:teamcollab:skills', capability: 'team.collaboration', validate: (p) => ({ teamId: id(p && (p as { teamId?: unknown }).teamId) }) },
  { channel: 'cc:teamcollab:queue', capability: 'team.collaboration', validate: (p) => ({ teamId: id(p && (p as { teamId?: unknown }).teamId) }) },
  { channel: 'cc:screen:capture', capability: 'screen.capture', validate: (p) => ({
      format: optStr(p && (p as { format?: unknown }).format) ?? 'png',
      quality: (p && (p as { quality?: unknown }).quality) ?? 80,
    }) },
  { channel: 'cc:screen:sources', capability: 'screen.capture', validate: (p) => (p === undefined ? {} : {}) },
];

export const CHANNEL_NAMES: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.channel));

export function channelDef(name: string): ChannelDef | undefined {
  return CHANNELS.find((c) => c.channel === name);
}