/**
 * Ambient Electron types (declaration-only).
 *
 * The desktop code is validated without shipping the Electron binary: modules
 * import `electron` for their types only, and every Electron entry point adapts
 * it at runtime through `import('electron')`. These ambient declarations keep
 * `tsc`/`vitest` (pure Node) green while the packaged app uses the real module.
 * Packaging (electron-builder / `npm i -D electron`) is intentionally an
 * incremental step, NOT part of this foundation pass.
 */
declare module 'electron' {
  type Listener = (...args: any[]) => void;
  type Event = { preventDefault(): void };

  export interface WebPreferences {
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
    preload?: string;
    webSecurity?: boolean;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    title?: string;
    show?: boolean;
    icon?: string;
    backgroundColor?: string;
    webPreferences?: WebPreferences;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    close(): void;
    destroy(): void;
    on(event: string, listener: Listener): this;
    once(event: string, listener: Listener): this;
    show(): void;
    setWindowOpenHandler(handler: (details: unknown) => { action: 'allow' | 'deny' }): void;
    webContents: WebContents;
    static getAllWindows(): BrowserWindow[];
  }

  export interface WebContents {
    id: number;
    frameId: number;
    send(channel: string, ...args: unknown[]): void;
    on(event: string, listener: Listener): void;
    setWindowOpenHandler(handler: (details: unknown) => { action: 'allow' | 'deny' }): void;
  }

  export interface IpcMainEvent {
    sender: WebContents;
    senderFrame: unknown;
  }

  export interface IpcMainInvokeEvent {
    sender: WebContents;
    senderFrame: unknown;
    frameId: number;
  }

  export interface IpcMain {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  }

  export interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: Listener): void;
    removeListener(channel: string, listener: Listener): void;
  }

  export interface ContextBridge {
    exposeInMainWorld(key: string, api: unknown): void;
  }

  export interface App {
    getVersion(): string;
    getPath(name: 'userData'): string;
    on(event: string, listener: Listener): this;
    whenReady(): Promise<void>;
    quit(): void;
    exit(code: number): void;
  }

  export interface Session {
    setPermissionRequestHandler(handler: (wc: unknown, permission: unknown, done: (granted: boolean) => void) => void): void;
  }

  export const app: App;
  export const ipcMain: IpcMain;
  export const ipcRenderer: IpcRenderer;
  export const contextBridge: ContextBridge;
  export const shell: { openExternal(url: string): Promise<void> };
  export const session: { defaultSession: Session };
}

declare namespace NodeJS {
  interface ProcessVersions {
    electron?: string;
  }
}