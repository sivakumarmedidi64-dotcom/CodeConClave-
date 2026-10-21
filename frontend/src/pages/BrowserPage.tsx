/**
 * CodeConClave — Browser.
 *
 * In the desktop app this is a real built-in browser (not an extension): the
 * app lays a sandboxed page view over the stage below, with its own session,
 * http(s) only. The user also picks where links open — the built-in browser,
 * the system default, or any browser installed on the computer.
 *
 * On the web, sites can't be embedded (most refuse to load in a frame), so the
 * page says so plainly and opens them in a new tab instead.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { desktopBrowser, onDesktopEvent, type BrowserPaneState } from '../lib/desktopBridge';

/** Same rules as the desktop pane: http(s), bare hosts, localhost, else a search. */
export function toBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).toString();
    } catch {
      return null;
    }
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`;
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(raw)) return `https://${raw}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

const EMPTY: BrowserPaneState = { available: false, open: false, visible: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false };

/**
 * Desktop only: a link clicked anywhere in the app, while the built-in browser
 * is the user's pick, opens on the Browser page. Mounted once in the shell.
 */
export function DesktopBrowserLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!desktopBrowser()) return;
    let off: () => void = () => undefined;
    let alive = true;
    void onDesktopEvent('browser-request', (p) => {
      const url = (p as { url?: unknown } | null)?.url;
      if (typeof url === 'string' && toBrowserUrl(url)) navigate(`/browser?url=${encodeURIComponent(url)}`);
    }).then((fn) => {
      if (alive) off = fn;
      else fn();
    });
    return () => {
      alive = false;
      off();
    };
  }, [navigate]);
  return null;
}

export function BrowserPage() {
  const browser = desktopBrowser();
  const location = useLocation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserPaneState>(EMPTY);
  const [address, setAddress] = useState('');
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  const [choice, setChoice] = useState('builtin');
  const [note, setNote] = useState<string | null>(null);

  const rect = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(0, r.width), height: Math.max(0, r.height) } : undefined;
  }, []);

  // Desktop: load state + browser choices, follow pane events, keep the pane on the stage.
  useEffect(() => {
    if (!browser) return;
    let alive = true;
    void browser.state().then((s) => {
      if (!alive) return;
      setState(s);
      if (s.url) setAddress(s.url);
      if (s.open) {
        const b = rect();
        if (b) void browser.setBounds(b);
        void browser.show();
      }
    });
    void browser
      .list()
      .then((l) => {
        if (!alive) return;
        setChoices(l.browsers);
        setChoice(l.choice);
      })
      .catch(() => undefined);
    let off: () => void = () => undefined;
    void onDesktopEvent('browser', (p) => {
      const s = p as BrowserPaneState;
      setState(s);
      if (s.url) setAddress(s.url);
    }).then((fn) => {
      if (alive) off = fn;
      else fn();
    });
    const follow = () => {
      const b = rect();
      if (b) void browser.setBounds(b);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(follow) : null;
    if (stageRef.current && ro) ro.observe(stageRef.current);
    window.addEventListener('resize', follow);
    return () => {
      alive = false;
      off();
      ro?.disconnect();
      window.removeEventListener('resize', follow);
      // Leaving the page hides the pane; the page you were on stays loaded.
      void browser.hide();
    };
  }, [browser, rect]);

  // The native page view sits above the DOM: hide it while a dialog is open
  // (command palette, setup, confirmations) so the dialog stays visible.
  const overlaid = useRef(false);
  useEffect(() => {
    if (!browser || typeof MutationObserver === 'undefined') return;
    const check = () => {
      const hasDialog = Boolean(document.querySelector('[aria-modal="true"]'));
      if (hasDialog === overlaid.current) return;
      overlaid.current = hasDialog;
      void (hasDialog ? browser.hide() : browser.state().then((s) => (s.open ? browser.show() : s)));
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [browser]);

  // /browser?url=… (a link clicked elsewhere in the app) opens right away.
  const requested = new URLSearchParams(location.search).get('url');
  useEffect(() => {
    if (!browser || !requested) return;
    const url = toBrowserUrl(requested);
    if (!url) return;
    setAddress(url);
    void browser.open(url, rect()).then(setState).catch(() => undefined);
  }, [browser, requested, rect]);

  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    setNote(null);
    const url = toBrowserUrl(address);
    if (!url) {
      setNote('Only web pages (http and https) can be opened.');
      return;
    }
    if (!browser) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      if (choice === 'builtin') setState(await browser.open(url, rect()));
      else {
        const out = await browser.openExternal(url);
        setNote(`Opened in ${out.openedIn}.`);
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not open that page.');
    }
  };

  const pick = async (next: string) => {
    if (!browser) return;
    try {
      await browser.choose(next);
      setChoice(next);
      if (next !== 'builtin') void browser.hide();
      else if (state.open) void browser.show();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not change the browser.');
    }
  };

  const openOutside = async () => {
    if (!browser || !state.url) return;
    const out = await browser.openExternal(state.url).catch(() => null);
    if (out) setNote(`Opened in ${out.openedIn}.`);
  };

  return (
    <div className="cc-page cc-browser">
      <form className="cc-browser__bar" onSubmit={(e) => void go(e)}>
        {browser && choice === 'builtin' && (
          <>
            <button type="button" className="cc-icon-btn" aria-label="Back" disabled={!state.canGoBack} onClick={() => void browser.nav('back').then(setState)}>
              <Icon name="arrow-down" size={14} className="cc-rot90" />
            </button>
            <button type="button" className="cc-icon-btn" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void browser.nav('forward').then(setState)}>
              <Icon name="arrow-down" size={14} className="cc-rot-90" />
            </button>
            <button
              type="button"
              className="cc-icon-btn"
              aria-label={state.loading ? 'Stop loading' : 'Reload'}
              disabled={!state.open}
              onClick={() => void browser.nav(state.loading ? 'stop' : 'reload').then(setState)}
            >
              <Icon name={state.loading ? 'close' : 'refresh'} size={14} />
            </button>
          </>
        )}
        <input
          className="cc-input cc-browser__address"
          aria-label="Address"
          placeholder="Search or type a web address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="cc-btn cc-btn--primary cc-btn--sm">
          Go
        </button>
        {browser && (
          <select className="cc-input cc-browser__choice" aria-label="Open pages in" value={choice} onChange={(e) => void pick(e.target.value)}>
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        {browser && choice === 'builtin' && state.open && (
          <>
            <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openOutside()} title="Open this page in your own browser">
              <Icon name="external" size={13} /> Open outside
            </button>
            <button type="button" className="cc-icon-btn" aria-label="Close browser" onClick={() => void browser.close().then(setState)}>
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </form>
      {note && <p className="cc-hint" role="status">{note}</p>}

      {browser ? (
        <div ref={stageRef} className="cc-browser__stage" data-testid="browser-stage" aria-label={state.title || 'Browser'}>
          {!state.open && (
            <div className="cc-browser__empty">
              <Icon name="compass" size={28} />
              <strong>{choice === 'builtin' ? 'Built-in browser' : `Pages open in ${choices.find((c) => c.id === choice)?.name ?? 'your browser'}`}</strong>
              <span>
                {choice === 'builtin'
                  ? 'Type an address or a search above. It runs inside CodeConClave, in its own private session — your app login and its cookies never mix.'
                  : 'Change “Open pages in” to use the built-in browser instead.'}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="cc-browser__stage cc-browser__stage--web" data-testid="browser-web">
          <div className="cc-browser__empty">
            <Icon name="monitor" size={28} />
            <strong>The built-in browser is in the CodeConClave desktop app</strong>
            <span>
              On the web, most sites refuse to load inside another page, so CodeConClave opens them in a new tab of the browser you're using now. In the
              desktop app you get a real browser pane next to your work, and you can choose Chrome, Edge, Firefox or Brave for outside links.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
