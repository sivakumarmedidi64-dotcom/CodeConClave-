/**
 * CodeConClave Desktop — built-in browser pane (main-process logic).
 *
 * A real browser inside the app window, NOT an extension and NOT a <webview>
 * tag: the main process owns one sandboxed view (see electron/browser-view.ts)
 * and lays it over the rectangle the renderer reserves for it. This class is
 * the Electron-free part — URL policy, state, bounds — so it is unit-tested
 * with a fake view.
 *
 * Policy:
 *   - only http(s) pages load; file:, javascript:, data:, chrome:, devtools: etc.
 *     are refused (a bare "example.com" becomes https://example.com, plain
 *     words become a web search)
 *   - the view has its own persistent session, no preload, no Node, sandbox on,
 *     and is never an IPC sender (the registry only trusts the app's top frame)
 */

export interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface PaneView {
  load(url: string): Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  setBounds(bounds: PaneBounds): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  state(): PaneViewState;
}

/** Creates the real view; `onChange` fires on navigation/title/loading changes. */
export type PaneViewFactory = (onChange: () => void) => PaneView;

export interface BrowserPaneState extends PaneViewState {
  available: boolean;
  open: boolean;
  visible: boolean;
}

export const SEARCH_URL = 'https://duckduckgo.com/?q=';

/**
 * Address-bar input → a loadable http(s) URL, or null when it is refused.
 * Mirrors what people type: full URLs, bare hosts, localhost:port, or words.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 4096) return null;
  // An explicit scheme must be http(s).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && !/^(localhost|[\w-]+(\.[\w-]+)*):\d+/i.test(raw)) {
    const s = scheme[1]!.toLowerCase();
    if (s !== 'http' && s !== 'https') return null;
    try {
      const u = new URL(raw);
      return u.hostname ? u.toString() : null;
    } catch {
      return null;
    }
  }
  // localhost / 127.0.0.1 (with optional port and path) → http.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(raw)) return new URL(`http://${raw}`).toString();
  // Looks like a host: has a dot, no spaces → https.
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(raw)) {
    try {
      return new URL(`https://${raw}`).toString();
    } catch {
      return null;
    }
  }
  return SEARCH_URL + encodeURIComponent(raw);
}

function cleanBounds(b: PaneBounds): PaneBounds {
  const n = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(v) ? v : 0)));
  return { x: n(b.x, 20000), y: n(b.y, 20000), width: n(b.width, 20000), height: n(b.height, 20000) };
}

export class BrowserPane {
  private view: PaneView | null = null;
  private visible = false;
  private bounds: PaneBounds | null = null;

  constructor(
    private readonly factory: PaneViewFactory | null,
    private readonly onState: (state: BrowserPaneState) => void = () => undefined,
  ) {}

  get available(): boolean {
    return this.factory !== null;
  }

  state(): BrowserPaneState {
    const v = this.view?.state() ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false };
    return { ...v, available: this.available, open: this.view !== null, visible: this.visible };
  }

  private emit(): void {
    this.onState(this.state());
  }

  private ensureView(): PaneView {
    if (!this.factory) throw new Error('The built-in browser needs the CodeConClave desktop app.');
    if (!this.view) {
      this.view = this.factory(() => this.emit());
      if (this.bounds) this.view.setBounds(this.bounds);
    }
    return this.view;
  }

  /** Open (or reuse) the pane at `url`, laid over `bounds` when given. */
  async open(input: string, bounds?: PaneBounds): Promise<BrowserPaneState> {
    const url = normalizeBrowserUrl(input);
    if (!url) throw new Error('Only web pages (http and https) can open in the built-in browser.');
    const view = this.ensureView();
    if (bounds) this.setBounds(bounds);
    view.setVisible(true);
    this.visible = true;
    await view.load(url);
    this.emit();
    return this.state();
  }

  async navigate(input: string): Promise<BrowserPaneState> {
    return this.open(input);
  }

  nav(action: 'back' | 'forward' | 'reload' | 'stop'): BrowserPaneState {
    const view = this.view;
    if (view) {
      if (action === 'back') view.back();
      else if (action === 'forward') view.forward();
      else if (action === 'reload') view.reload();
      else view.stop();
    }
    this.emit();
    return this.state();
  }

  setBounds(b: PaneBounds): BrowserPaneState {
    this.bounds = cleanBounds(b);
    this.view?.setBounds(this.bounds);
    return this.state();
  }

  /** Hide while the renderer shows something else; the page keeps its state. */
  hide(): BrowserPaneState {
    this.visible = false;
    this.view?.setVisible(false);
    this.emit();
    return this.state();
  }

  show(): BrowserPaneState {
    if (this.view) {
      this.visible = true;
      this.view.setVisible(true);
      this.emit();
    }
    return this.state();
  }

  close(): BrowserPaneState {
    this.view?.destroy();
    this.view = null;
    this.visible = false;
    this.emit();
    return this.state();
  }
}
