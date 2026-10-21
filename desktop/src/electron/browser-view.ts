/**
 * CodeConClave Desktop — the real view behind the built-in browser pane.
 *
 * One WebContentsView laid over the app window (not a <webview> tag, not an
 * extension). Hardened like the main window, and separate from it:
 *   - its own persistent session ("persist:cc-browser"): cookies and logins
 *     there never mix with the CodeConClave app session
 *   - sandbox + contextIsolation, no Node, no preload → it can't reach IPC
 *   - camera/mic/location/notification requests are denied
 *   - only http(s) navigations; pop-ups open in the same pane
 *   - downloads keep Electron's default Save dialog (the user picks the file)
 */
import { WebContentsView, session, type BrowserWindow } from 'electron';
import type { PaneBounds, PaneView, PaneViewFactory } from '../local/browser-pane.js';

export const BROWSER_PARTITION = 'persist:cc-browser';

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export function electronPaneFactory(win: BrowserWindow): PaneViewFactory {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  return (onChange: () => void): PaneView => {
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) void wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (!isWeb(url)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    const changed = () => onChange();
    wc.on('did-navigate', changed);
    wc.on('did-navigate-in-page', changed);
    wc.on('page-title-updated', changed);
    wc.on('did-start-loading', changed);
    wc.on('did-stop-loading', changed);

    view.setVisible(false);
    win.contentView.addChildView(view);

    // The renderer measures in CSS pixels; scale by the app window's zoom.
    const place = (b: PaneBounds) => {
      const z = win.webContents.getZoomFactor() || 1;
      view.setBounds({ x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) });
    };

    return {
      load: async (url) => {
        // loadURL rejects on aborted/failed loads; the page shows Chromium's own error.
        await wc.loadURL(url).catch(() => undefined);
      },
      back: () => {
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      },
      forward: () => {
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      },
      reload: () => wc.reload(),
      stop: () => wc.stop(),
      setBounds: place,
      setVisible: (visible) => view.setVisible(visible),
      destroy: () => {
        win.contentView.removeChildView(view);
        if (!wc.isDestroyed()) wc.close();
      },
      state: () => ({
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
      }),
    };
  };
}
