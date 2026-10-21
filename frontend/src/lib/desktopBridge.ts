/**
 * The CodeConClave desktop app exposes a frozen, allow-listed bridge on
 * `window.codeconclave` (desktop/src/preload). On the web it is absent and
 * every helper here returns null — callers show the web fallback.
 */

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPaneState {
  available: boolean;
  open: boolean;
  visible: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface DesktopBrowser {
  state(): Promise<BrowserPaneState>;
  open(url: string, bounds?: PaneRect): Promise<BrowserPaneState>;
  nav(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserPaneState>;
  setBounds(bounds: PaneRect): Promise<BrowserPaneState>;
  show(): Promise<BrowserPaneState>;
  hide(): Promise<BrowserPaneState>;
  close(): Promise<BrowserPaneState>;
  list(): Promise<{ choice: string; builtinAvailable: boolean; browsers: { id: string; name: string }[] }>;
  choose(choice: string): Promise<{ choice: string }>;
  openExternal(url: string): Promise<{ ok: boolean; openedIn: string }>;
}

interface DesktopBridgeShape {
  isDesktopBridge?: boolean;
  desktop?: {
    browser?: DesktopBrowser;
    monitor?: { subscribe(cb: (msg: { name: string; payload: unknown }) => void): Promise<() => void> };
  };
}

function bridge(): DesktopBridgeShape | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { codeconclave?: DesktopBridgeShape }).codeconclave;
  return b && b.isDesktopBridge ? b : null;
}

/** The built-in browser, or null outside the desktop app. */
export function desktopBrowser(): DesktopBrowser | null {
  return bridge()?.desktop?.browser ?? null;
}

/** Subscribe to one desktop event (e.g. 'browser'); a no-op on the web. */
export async function onDesktopEvent(name: string, cb: (payload: unknown) => void): Promise<() => void> {
  const monitor = bridge()?.desktop?.monitor;
  if (!monitor) return () => undefined;
  return monitor.subscribe((msg) => {
    if (msg.name === name) cb(msg.payload);
  });
}
