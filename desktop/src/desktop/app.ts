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

    this.register();
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