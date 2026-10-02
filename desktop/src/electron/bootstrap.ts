/**
 * CodeConClave Desktop — Electron bootstrap (main process).
 *
 * Creates a HARDENED BrowserWindow:
 *   - contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true
 *   - navigation allow-list (only the configured backend origin)
 *   - new-window / webview attach denied; permissions denied by default
 *   - shell.openExternal never used for windowing
 * Adapts the DesktopApp IPC registry to ipcMain.handle with sender identity
 * derived from the real event (top frame only). Secrets never cross to the
 * renderer: only the allow-listed typed surface exists.
 */
import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage } from 'electron';
import { type IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { loadConfig } from '@codeconclave/local-agent/config';
import { DesktopApp } from '../desktop/app.js';
import { SettingsStore, defaultSettingsPath } from '../desktop/settings.js';
import { CHANNELS, IpcPayloadError } from '../ipc/channels.js';
import { IpcSecurityError, type SenderIdentity } from '../ipc/registry.js';
import { DESKTOP_EVENTS } from '../types.js';
import { ensureEmbeddedApp } from './spa-server.js';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

export function appOrigin(): string {
  try {
    return new URL(new SettingsStore({ path: defaultSettingsPath(app.getPath('userData')) }).read().appUrl).origin;
  } catch {
    return '';
  }
}

/** Navigation allow-list: only the configured backend origin may be hosted. */
function isAllowedTarget(url: string): boolean {
  const origin = appOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function senderIdentity(event: IpcMainInvokeEvent): SenderIdentity {
  return {
    frameId: event.frameId ?? 0,
    isTopFrame: event.sender.id === win?.webContents.id,
    origin: (event.senderFrame as { origin?: string } | null)?.origin ?? null,
  };
}

/**
 * Canonical desktop icon (derived from the authoritative brand mark in
 * assets/brand/). Only set when the file actually exists at runtime — no
 * fabricated/broken icon, and never an icon that wasn't shipped.
 */
function desktopIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../../assets/icon.png'),
    join(__dirname, '../../../assets/brand/icon-256.png'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return undefined;
}

export async function launchDesktopApp(): Promise<void> {
  const settings = new SettingsStore({ path: defaultSettingsPath(app.getPath('userData')) });
  const cfg = loadConfig();
  const grants = cfg?.workspaces ?? [];
  const desktop = new DesktopApp({
    baseUrl: settings.read().appUrl,
    grants,
    settings,
  });

  // Adapt every allow-listed channel to ipcMain.handle with boundary checks.
  for (const def of CHANNELS) {
    ipcMain.handle(def.channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      try {
        return await desktop.dispatch(def.channel, payload, senderIdentity(event));
      } catch (err) {
        if (err instanceof IpcSecurityError || err instanceof IpcPayloadError) {
          return { error: { code: err.code, message: err.message } };
        }
        throw err;
      }
    });
  }

  const preloadPath = join(__dirname, '../preload/index.cjs');
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'CodeConClave',
    show: false,
    // Brand-black launch background (matches the black rounded-rect mark):
    // the window paints black immediately and never flashes a white pane
    // before the renderer (brand theme) is ready.
    backgroundColor: '#000000',
    icon: desktopIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedTarget(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler((_details) => ({ action: 'deny' }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Forward allow-listed events to the renderer on the single 'cc:event' bus.
  for (const name of DESKTOP_EVENTS) {
    desktop.bus.subscribe(name, (msg) => {
      win?.webContents.send('cc:event', msg);
    });
  }

  desktop.start();

  // Start the embedded web UI (desktop's own server.cjs + frontend dist) on
  // http://localhost:8080 when no custom origin is configured, then load it.
  const appUrl = settings.read().appUrl;
  const embedded = await ensureEmbeddedApp(appUrl, (line) => console.log(line));
  const stopEmbedded = () => embedded?.stop();
  app.on('will-quit', stopEmbedded);
  app.on('will-quit', () => {
    tray?.destroy();
  });
  app.on('window-all-closed', stopEmbedded);

  await win.loadURL(embedded ? embedded.url : appUrl);

  // System tray
  const iconPath = desktopIconPath();
  if (iconPath) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show CodeConClave',
        click: () => {
          win?.show();
          win?.focus();
        },
      },
      {
        label: 'Hide to Tray',
        click: () => {
          win?.hide();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit CodeConClave',
        click: () => {
          app.quit();
        },
      },
    ]);
    tray.setToolTip('CodeConClave');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      win?.show();
      win?.focus();
    });
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}