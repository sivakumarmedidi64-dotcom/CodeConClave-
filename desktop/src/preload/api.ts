/**
 * CodeConClave Desktop — preload API builder.
 *
 * Builds the renderer surface from the CHANNELS allow-list only: each method
 * maps 1:1 to a fixed channel and forwards a payload. The returned object is
 * deep-frozen and contains NO generic invoke/send/require/exec primitives, so
 * there is nothing for a compromised renderer to escalate on. The `call`
 * adapter is provided by the real preload (ipcRenderer.invoke) or by tests.
 */
import { CHANNELS, type IpcChannelName } from '../ipc/channels.js';
import type { DesktopBridge, DesktopSurface, EntitlementStatus } from './contract.js';

export interface PreloadDeps {
  call: (channel: IpcChannelName, payload: unknown) => Promise<unknown>;
  /** subscribe to typed main→renderer events; returns unsubscribe. */
  on: (name: string, cb: (payload: unknown) => void) => () => void;
  platform: NodeJS.Platform;
  appVersion: string;
  electronRuntime: boolean;
}

export function buildPreloadApi(deps: PreloadDeps): DesktopBridge {
  const surface: DesktopSurface = {
    platform: deps.platform,
    versions: { app: deps.appVersion, electron: deps.electronRuntime },
    auth: {
      status: () => deps.call('cc:auth:status', {}).then((v) => v as unknown as EntitlementStatus),
      entitlement: () => deps.call('cc:entitlement:read', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['auth']['entitlement']>>),
    },
    workspace: {
      list: () => deps.call('cc:workspace:list', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['workspace']['list']>>),
      open: (root: string) => deps.call('cc:workspace:open', { root }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['workspace']['open']>>),
      detect: () => deps.call('cc:workspace:detect', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['workspace']['detect']>>),
    },
    files: {
      list: (relPath?: string) => deps.call('cc:files:list', { relPath }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['list']>>),
      read: (relPath: string) => deps.call('cc:files:read', { relPath }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['read']>>),
      metadata: (relPath: string) => deps.call('cc:files:metadata', { relPath }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['metadata']>>),
      diff: (relPath: string, content: string) => deps.call('cc:files:diff', { relPath, content }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['diff']>>),
      write: (relPath: string, content: string) => deps.call('cc:files:write', { relPath, content }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['write']>>),
      attach: (paths: string[]) => deps.call('cc:files:attach', { paths }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['attach']>>),
      drop: (paths: string[]) => deps.call('cc:files:drop', { paths }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['files']['drop']>>),
    },
    undo: {
      list: () => deps.call('cc:undo:list', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['undo']['list']>>),
      rollback: (id: string) => deps.call('cc:undo:rollback', { id }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['undo']['rollback']>>),
    },
    terminal: {
      open: (shell: string, cwd: string) => deps.call('cc:terminal:open', { shell, cwd }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['terminal']['open']>>),
      write: (tabId: string, line: string) => deps.call('cc:terminal:write', { tabId, line }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['terminal']['write']>>),
      kill: (tabId: string) => deps.call('cc:terminal:kill', { tabId }).then((v) => v as unknown as Promise<void>),
      list: () => deps.call('cc:terminal:list', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['terminal']['list']>>),
    },
    git: {
      status: () => deps.call('cc:git:status', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['git']['status']>>),
      diff: (relPath?: string) => deps.call('cc:git:diff', { relPath }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['git']['diff']>>),
    },
    task: {
      list: () => deps.call('cc:task:list', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['task']['list']>>),
    },
    reconnect: {
      status: () => deps.call('cc:reconnect:status', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['reconnect']['status']>>),
      reconnect: () => deps.call('cc:reconnect:now', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['reconnect']['reconnect']>>),
    },
    cowork: {
      resume: (sessionId: string) => deps.call('cc:cowork:resume', { sessionId }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['cowork']['resume']>>),
    },
    settings: {
      read: () => deps.call('cc:settings:read', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['settings']['read']>>),
      setTheme: (theme: 'light' | 'dark' | 'system') => deps.call('cc:settings:ui', { theme }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['settings']['setTheme']>>),
    },
    voice: {
      support: () => deps.call('cc:voice:support', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['voice']['support']>>),
    },
    teamCollab: {
      support: () => deps.call('cc:teamcollab:support', {}).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['teamCollab']['support']>>),
      presence: (teamId: string) => deps.call('cc:teamcollab:presence', { teamId }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['teamCollab']['presence']>>),
      skills: (teamId: string) => deps.call('cc:teamcollab:skills', { teamId }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['teamCollab']['skills']>>),
      queue: (teamId: string) => deps.call('cc:teamcollab:queue', { teamId }).then((v) => v as unknown as Awaited<ReturnType<DesktopSurface['teamCollab']['queue']>>),
    },
    screen: {
      capture: (options?: { format?: 'png' | 'jpeg'; quality?: number }) =>
        deps.call('cc:screen:capture', options ?? {}).then((v) => v as unknown as Uint8Array | null),
      sources: () => deps.call('cc:screen:sources', {}).then((v) => v as unknown as Array<{ id: string; name: string; display_id?: string; thumbnail: { width: number; height: number } }>),
    },
    monitor: {
      subscribe: async (cb) =>
        deps.on('cc:event', (payload) => {
          const msg = payload as { name: string; payload: unknown };
          cb({ name: msg.name as never, payload: msg.payload });
        }),
    },
  };

  return deepFreeze({ isDesktopBridge: true as const, desktop: surface });
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const v = (obj as Record<string, unknown>)[k];
      if (v && typeof v === 'object') deepFreeze(v);
    }
    Object.freeze(obj);
  }
  return obj;
}

export { CHANNELS };