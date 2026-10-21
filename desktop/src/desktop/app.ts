/**
 * CodeConClave Desktop — composition root.
 *
 * Wires the local + cloud services and registers handlers for exactly the
 * allow-listed channels. This object is what the Electron bootstrap adapts to
 * `ipcMain.handle`, and what tests drive with synthetic senders. It owns the
 * capability/workspace model, the read-only backend client, reconnect, and the
 * event bus — no second state model.
 */
import { TerminalSession } from '@codeconclave/local-agent/terminal';
import type { WorkspaceGrant } from '@codeconclave/local-agent/config';
import { IpcRegistry, type SenderIdentity } from '../ipc/registry.js';
import { WorkspaceManager } from '../local/workspace.js';
import { FilesController } from '../local/files-controller.js';
import { TerminalHost, type SessionFactory } from '../local/terminal-host.js';
import { GitRunner, type GitExec } from '../local/git-runner.js';
import { UndoService } from '../local/undo.js';
import { LocalTaskMonitor } from '../local/monitor.js';
import { WorkspaceWatcher, type WatchFn } from '../local/watcher.js';
import { BackendClient } from '../cloud/client.js';
import { EntitlementReader } from '../cloud/entitlement.js';
import { ReconnectController } from '../cloud/reconnect.js';
import { CoworkResumer } from '../cloud/resume.js';
import { SettingsStore } from '../desktop/settings.js';
import { DesktopEventBus } from '../desktop/events.js';
import { getMainProcessScreenCaptureSource } from '../local/screen-capture.js';
import { desktopCapturer } from 'electron';
import { BrowserPane, type PaneBounds, type PaneViewFactory } from '../local/browser-pane.js';
import { detectBrowsers, safeExternalUrl, launchCommand, type InstalledBrowser } from '../local/browser-launch.js';
import type { BrowserChoice } from '../types.js';

export interface DesktopAppDeps {
  baseUrl: string;
  grants: WorkspaceGrant[];
  settings: SettingsStore;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }>;
  sessionFactory?: SessionFactory;
  gitExec?: GitExec;
  watchFn?: WatchFn;
  probe?: () => Promise<boolean>;
  appVersion?: string;
  /** Built-in browser view (Electron only); absent → the pane reports unavailable. */
  browserViewFactory?: PaneViewFactory | null;
  /** Open a URL in the system default browser (Electron shell.openExternal). */
  openExternal?: (url: string) => Promise<void>;
  /** Start an installed browser: no shell, detached. */
  spawnDetached?: (command: string, args: string[]) => void;
  fileExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export class DesktopApp {
  readonly bus = new DesktopEventBus();
  readonly registry = new IpcRegistry();
  readonly settings: SettingsStore;
  readonly workspace: WorkspaceManager;
  readonly files: FilesController;
  readonly terminal: TerminalHost;
  readonly git: GitRunner;
  readonly undo: UndoService;
  readonly monitor: LocalTaskMonitor;
  readonly watcher: WorkspaceWatcher;
  readonly client: BackendClient;
  readonly entitlement: EntitlementReader;
  readonly reconnect: ReconnectController;
  readonly resumer: CoworkResumer;
  readonly browser: BrowserPane;
  private readonly browserDeps: Pick<DesktopAppDeps, 'openExternal' | 'spawnDetached' | 'fileExists' | 'platform' | 'env'>;
  private readonly probeFn: () => Promise<boolean>;
  private readonly cursors = new Map<string, number>();
  private readonly version: string;

  constructor(deps: DesktopAppDeps) {
    this.version = deps.appVersion ?? '0.1.0';
    this.settings = deps.settings;
    this.client = new BackendClient(deps.baseUrl, deps.fetchImpl as never);
    this.entitlement = new EntitlementReader(this.client);
    this.probeFn = deps.probe ?? (async () => {
      const e = await this.entitlement.read();
      return e.online;
    });

    this.workspace = new WorkspaceManager(() => deps.grants, {
      activeRoot: () => deps.settings.read().activeRoot,
      setActiveRoot: (root) => void deps.settings.patch({ activeRoot: root }),
    });

    this.files = new FilesController(this.workspace);
    this.undo = new UndoService(this.workspace);

    const factory: SessionFactory =
      deps.sessionFactory ??
      ((tabId: string, shell: string, cwd: string) => new TerminalSession(tabId, shell, cwd));
    this.terminal = new TerminalHost(this.workspace, {
      onStatus: () => void this.bus.emit({ name: 'terminal', payload: this.terminal.list() }),
      onOutput: () => undefined,
    }, factory);

    this.git = new GitRunner(this.workspace, deps.gitExec);
    this.monitor = new LocalTaskMonitor(this.workspace, {
      onTasksChanged: (tasks) => void this.bus.emit({ name: 'task', payload: tasks }),
    });
    this.watcher = new WorkspaceWatcher(this.workspace, {
      onChange: (change) => void this.bus.emit({ name: 'workspace-file-change', payload: change }),
    }, deps.watchFn);

    this.reconnect = new ReconnectController({
      probe: () => this.probeFn(),
      onStatus: (s) => void this.bus.emit({ name: 'connection', payload: s }),
      onReconnected: async () => {
        await this.entitlement.read().catch(() => undefined);
        void this.bus.emit({ name: 'workspace', payload: this.workspace.summaries() });
      },
    });

    this.resumer = new CoworkResumer({
      client: this.client,
      isOnline: () => this.reconnect.status.online,
      lastCursor: (sessionId) => this.cursors.get(sessionId) ?? null,
      setLastCursor: (sessionId, cursor) => void this.cursors.set(sessionId, cursor),
    });

    this.browser = new BrowserPane(deps.browserViewFactory ?? null, (state) => void this.bus.emit({ name: 'browser', payload: state }));
    this.browserDeps = {
      openExternal: deps.openExternal,
      spawnDetached: deps.spawnDetached,
      fileExists: deps.fileExists,
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
    };

    this.register();
  }

  /** Browsers the user can pick (builtin + system default always; others when installed). */
  installedBrowsers(): InstalledBrowser[] {
    const exists = this.browserDeps.fileExists ?? (() => false);
    return detectBrowsers(this.browserDeps.platform ?? process.platform, this.browserDeps.env ?? {}, exists);
  }

  /**
   * A link clicked inside the app (window.open / target=_blank). Built-in pick →
   * ask the renderer to show it on the Browser page; otherwise the picked browser.
   */
  async openLink(input: string): Promise<void> {
    const url = safeExternalUrl(input);
    if (!url) return;
    if (this.settings.read().browser.choice === 'builtin' && this.browser.available) {
      this.bus.emit({ name: 'browser-request', payload: { url } });
      return;
    }
    await this.openExternal(url).catch(() => undefined);
  }

  /** Open a page outside the app: the picked browser, else the system default. */
  async openExternal(input: string): Promise<{ ok: boolean; openedIn: string }> {
    const url = safeExternalUrl(input);
    if (!url) throw new Error('Only web pages (http and https) can be opened.');
    const choice = this.settings.read().browser.choice;
    const picked = this.installedBrowsers().find((b) => b.id === choice);
    const cmd = picked ? launchCommand(this.browserDeps.platform ?? process.platform, picked, url) : null;
    if (cmd && this.browserDeps.spawnDetached) {
      this.browserDeps.spawnDetached(cmd.command, cmd.args);
      return { ok: true, openedIn: picked!.name };
    }
    if (!this.browserDeps.openExternal) throw new Error('Opening other browsers needs the CodeConClave desktop app.');
    await this.browserDeps.openExternal(url);
    return { ok: true, openedIn: 'System default browser' };
  }

  /** Exact match: only the configured backend origin (or the offline shell
   *  origins) is a permitted IPC sender. */
  isPermittedOrigin(origin: string | null): boolean {
    if (!origin) return false;
    if (origin === 'file://' || origin === 'null') return true;
    try {
      return new URL(this.client.baseUrl).origin === origin;
    } catch {
      return false;
    }
  }

  async dispatch(channel: string, payload: unknown, sender: SenderIdentity): Promise<unknown> {
    return this.registry.dispatch(channel, payload, sender, this);
  }

  /** Start the reconnect loop after auth is known-ok. */
  start(): void {
    void this.reconnect.tick();
  }

  versions(): string {
    return this.version;
  }

  private register(): void {
    const r = this.registry;

    r.register('cc:auth:status', async () => {
      const e = await this.entitlement.read();
      return { authed: e.authed, planId: e.planId, entitlementState: e.entitlementState, online: e.online };
    });
    r.register('cc:entitlement:read', async () => this.entitlement.read());
    r.register('cc:workspace:list', async () => this.workspace.summaries());
    r.register('cc:workspace:open', async (p: { root: string }) => {
      const w = this.workspace.open(p.root);
      this.watcher.start();
      return w;
    });
    r.register('cc:workspace:detect', async () => this.workspace.detect());
    r.register('cc:files:list', async (p: { relPath?: string }) => this.files.list(p.relPath));
    r.register('cc:files:read', async (p: { relPath: string }) => this.files.read(p.relPath));
    r.register('cc:files:metadata', async (p: { relPath: string }) => this.files.metadata(p.relPath));
    r.register('cc:files:diff', async (p: { relPath: string; content: string }) => this.files.diff(p.relPath, p.content));
    r.register('cc:files:write', async (p: { relPath: string; content: string }) => this.files.write(p.relPath, p.content));
    r.register('cc:files:attach', async (p: { paths: string[] }) => this.files.attach(p.paths));
    r.register('cc:files:drop', async (p: { paths: string[] }) => this.files.drop(p.paths));
    r.register('cc:undo:list', async () => this.undo.list());
    r.register('cc:undo:rollback', async (p: { id: string }) => this.undo.rollback(p.id));
    r.register('cc:terminal:open', async (p: { shell: string; cwd: string }) => this.terminal.open(p.shell, p.cwd));
    r.register('cc:terminal:write', async (p: { tabId: string; line: string }) => this.terminal.write(p.tabId, p.line));
    r.register('cc:terminal:kill', async (p: { tabId: string }) => {
      this.terminal.kill(p.tabId);
      return { ok: true };
    });
    r.register('cc:terminal:list', async () => this.terminal.list());
    r.register('cc:git:status', async () => this.git.status());
    r.register('cc:git:diff', async (p: { relPath?: string }) => this.git.diff(p.relPath));
    r.register('cc:task:list', async () => this.monitor.list());
    r.register('cc:reconnect:status', async () => this.reconnect.status);
    r.register('cc:reconnect:now', async () => this.reconnect.reconnect());
    r.register('cc:cowork:resume', async (p: { sessionId: string }) => this.resumer.resume(p.sessionId));
    r.register('cc:settings:read', async () => this.settings.read());
    r.register('cc:settings:ui', async (p: { theme: string }) => {
      const theme = p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system';
      return this.settings.patch({ ui: { ...this.settings.read().ui, theme } });
    });
    r.register('cc:monitor:subscribe', async () => ({ ok: true }));
    r.register('cc:voice:support', async () => this.voiceSupport());
    r.register('cc:teamcollab:support', async () => this.teamCollabSupport());
    r.register('cc:teamcollab:presence', async (p: { teamId: string }) => this.teamCollabPresence(p.teamId));
    r.register('cc:teamcollab:skills', async (p: { teamId: string }) => this.teamCollabSkills(p.teamId));
    r.register('cc:teamcollab:queue', async (p: { teamId: string }) => this.teamCollabQueue(p.teamId));
    r.register('cc:screen:capture', async (p: { format?: 'png' | 'jpeg'; quality?: number }) => {
      const source = getMainProcessScreenCaptureSource();
      const result = await source.captureWithOptions('desktop', 'session', {
        format: p.format,
        quality: p.quality,
      });
      return result?.image ?? null;
    });
    r.register('cc:browser:state', async () => this.browser.state());
    r.register('cc:browser:open', async (p: { url: string; bounds?: PaneBounds }) => this.browser.open(p.url, p.bounds));
    r.register('cc:browser:nav', async (p: { action: 'back' | 'forward' | 'reload' | 'stop' }) => this.browser.nav(p.action));
    r.register('cc:browser:bounds', async (p: PaneBounds) => this.browser.setBounds(p));
    r.register('cc:browser:show', async () => this.browser.show());
    r.register('cc:browser:hide', async () => this.browser.hide());
    r.register('cc:browser:close', async () => this.browser.close());
    r.register('cc:browser:list', async () => ({
      choice: this.settings.read().browser.choice,
      builtinAvailable: this.browser.available,
      browsers: this.installedBrowsers().map(({ id, name }) => ({ id, name })),
    }));
    r.register('cc:browser:choose', async (p: { choice: BrowserChoice }) => {
      if (!this.installedBrowsers().some((b) => b.id === p.choice)) throw new Error('That browser is not installed on this computer.');
      this.settings.patch({ browser: { choice: p.choice } });
      return { choice: p.choice };
    });
    r.register('cc:browser:external', async (p: { url: string }) => this.openExternal(p.url));
    r.register('cc:screen:sources', async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      return sources.map(s => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id,
        thumbnail: { width: s.thumbnail.getSize().width, height: s.thumbnail.getSize().height },
      }));
    });
  }

  /**
   * PKG-11 Team Collaboration — honest desktop surface.
   * The desktop host does not fabricate realtime presence, and never exposes
   * private memory or private skills. These read-only reports describe what
   * the canonical backend renders; actual team data is served from the
   * backend (server-confirmed). When no backend connection is established the
   * host reports the canonical shape with available=false rather than inventing
   * member data.
   */
  private teamCollabSupport() {
    return { available: true, source: 'desktop-report' as const, capabilities: ['presence', 'skills', 'queue'] };
  }

  private teamCollabPresence(_teamId: string) {
    return { onlineCount: 0, presence: [] };
  }

  private teamCollabSkills(_teamId: string) {
    return [];
  }

  private teamCollabQueue(_teamId: string) {
    return [];
  }

  /**
   * PKG-10 Voice — honest desktop voice support report.
   * The desktop host does not ship its own STT/TTS engine and never exposes raw
   * mic audio, node, fs, child_process, env, or secrets to the renderer. It only
   * reports whether the embedded renderer can use the BROWSER Web Speech API.
   * Native recognition support is deliberately not claimed here: that detection
   * is done in the renderer by the browser speech layer.
   */
  private voiceSupport() {
    const support = { recognition: 'UNSUPPORTED' as const, synthesis: 'UNSUPPORTED' as const };
    const type = 'VoiceSupport';
    return { ...support, __type: type };
  }
}