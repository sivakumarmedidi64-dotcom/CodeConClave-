/**
 * CodeConClave Desktop — device/UI settings (LOCAL ONLY).
 * Purely local device preferences (theme, font scale, app URL, last workspace)
 * persisted to disk with 0600 permissions. These NEVER travel to the cloud:
 * account/auth/entitlement/workspace grants come from the backend / local-agent
 * config. No schema is required in the production database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';
import type { WorkspaceSettings } from '../types.js';

export interface SettingsFile {
  path: string;
}

export const DEFAULTS: WorkspaceSettings = {
  // The embedded SPA is served by the desktop's own copy of frontend/server.cjs
  // on the local origin below (see electron/spa-server.ts); /api and /health are
  // proxied to the local backend. Kept next to the web default so a packaged
  // app works on a clean machine with no dev server.
  appUrl: 'http://localhost:8080',
  activeRoot: null,
  ui: { theme: 'system', fontScale: 1 },
};

export function defaultSettingsPath(userDataDir: string): string {
  return `${userDataDir.replace(/[\\/]+$/, '')}${sep}settings.json`;
}

export interface SettingsIo {
  read(p: string): string | null;
  write(p: string, data: string): void;
}

export const realSettingsIo: SettingsIo = {
  read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  write: (p, data) => {
    const dir = p.split(/[\\/]/).slice(0, -1).join(sep);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort */
      }
    }
    writeFileSync(p, data, { mode: 0o600 });
  },
};

export class SettingsStore {
  constructor(
    private readonly file: SettingsFile,
    private readonly io: SettingsIo = realSettingsIo,
  ) {}

  read(): WorkspaceSettings {
    const raw = this.io.read(this.file.path);
    if (!raw) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSettings>;
      return {
        appUrl: typeof parsed.appUrl === 'string' ? parsed.appUrl : DEFAULTS.appUrl,
        activeRoot: typeof parsed.activeRoot === 'string' ? parsed.activeRoot : null,
        ui: {
          theme: parsed.ui?.theme === 'dark' || parsed.ui?.theme === 'light' ? parsed.ui.theme : 'system',
          fontScale: typeof parsed.ui?.fontScale === 'number' && parsed.ui.fontScale > 0 && parsed.ui.fontScale <= 3 ? parsed.ui.fontScale : 1,
        },
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  patch(patch: Partial<WorkspaceSettings>): WorkspaceSettings {
    const current = this.read();
    const merged: WorkspaceSettings = {
      ...current,
      ...patch,
      ui: { ...current.ui, ...(patch.ui ?? {}) },
    };
    this.io.write(this.file.path, JSON.stringify(merged, null, 2));
    return merged;
  }

  setActiveRoot(root: string | null): void {
    this.patch({ activeRoot: root });
  }
}