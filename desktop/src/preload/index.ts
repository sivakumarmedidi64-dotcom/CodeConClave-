/**
 * CodeConClave Desktop — Electron preload entry.
 * contextBridge exposes a frozen, allow-listed `window.codeconclave` surface.
 * The renderer never receives Node.js or raw IPC access. This file loads only
 * under a packaged Electron runtime; the bridge contract itself is tested
 * without Electron (see preload/api.test.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';
import { buildPreloadApi } from './api.js';

const api = buildPreloadApi({
  call: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (name: string, cb: (payload: unknown) => void) => {
    const listener = (_event: unknown, msg: unknown): void => {
      if (msg && typeof msg === 'object' && 'name' in (msg as { name?: unknown }) && (msg as { name?: unknown }).name === name) {
        cb(msg);
      }
    };
    ipcRenderer.on('cc:event', listener);
    return () => ipcRenderer.removeListener('cc:event', listener);
  },
  platform: (process.platform ?? 'win32') as NodeJS.Platform,
  appVersion: '0.1.0',
  electronRuntime: typeof process.versions.electron === 'string',
});

if (typeof contextBridge !== 'undefined') {
  contextBridge.exposeInMainWorld('codeconclave', api);
}

export { api };