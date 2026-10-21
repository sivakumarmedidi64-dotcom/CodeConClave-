/**
 * CodeConClave Desktop — "open in my browser": find the browsers installed on
 * this computer and open a page in the one the user picked.
 *
 * Electron-free and side-effect free except `launchCommand`'s caller: the
 * bootstrap passes a real `spawn` (no shell, URL as one argument) and
 * `shell.openExternal` for "System default". Only http(s) URLs ever leave.
 */

export type BrowserId = 'builtin' | 'default' | 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi';

export interface InstalledBrowser {
  id: BrowserId;
  name: string;
  /** Executable path (Windows/Linux) or app name (macOS); absent for builtin/default. */
  path?: string;
}

const NAMES: Record<BrowserId, string> = {
  builtin: 'CodeConClave browser (built in)',
  default: 'System default browser',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
};

export const BROWSER_IDS = Object.keys(NAMES) as BrowserId[];

export function isBrowserId(v: unknown): v is BrowserId {
  return typeof v === 'string' && (BROWSER_IDS as string[]).includes(v);
}

type Env = Record<string, string | undefined>;

/** Known install locations per platform (first existing path wins). */
export function candidatePaths(platform: NodeJS.Platform, env: Env): Partial<Record<BrowserId, string[]>> {
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? '';
    const w = (...parts: string[]) => parts.filter(Boolean).join('\\');
    return {
      chrome: [w(pf, 'Google\\Chrome\\Application\\chrome.exe'), w(pf86, 'Google\\Chrome\\Application\\chrome.exe'), local && w(local, 'Google\\Chrome\\Application\\chrome.exe')].filter(Boolean),
      edge: [w(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), w(pf, 'Microsoft\\Edge\\Application\\msedge.exe')],
      firefox: [w(pf, 'Mozilla Firefox\\firefox.exe'), w(pf86, 'Mozilla Firefox\\firefox.exe')],
      brave: [w(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'), local && w(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')].filter(Boolean),
      opera: [local && w(local, 'Programs\\Opera\\opera.exe')].filter(Boolean),
      vivaldi: [local && w(local, 'Vivaldi\\Application\\vivaldi.exe')].filter(Boolean),
    };
  }
  if (platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app'],
      edge: ['/Applications/Microsoft Edge.app'],
      firefox: ['/Applications/Firefox.app'],
      brave: ['/Applications/Brave Browser.app'],
      opera: ['/Applications/Opera.app'],
      vivaldi: ['/Applications/Vivaldi.app'],
    };
  }
  const bins = (names: string[]) => names.flatMap((n) => [`/usr/bin/${n}`, `/usr/local/bin/${n}`, `/snap/bin/${n}`]);
  return {
    chrome: bins(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']),
    edge: bins(['microsoft-edge', 'microsoft-edge-stable']),
    firefox: bins(['firefox']),
    brave: bins(['brave-browser', 'brave']),
    opera: bins(['opera']),
    vivaldi: bins(['vivaldi', 'vivaldi-stable']),
  };
}

/** Builtin + system default are always offered; others only when installed. */
export function detectBrowsers(platform: NodeJS.Platform, env: Env, exists: (p: string) => boolean): InstalledBrowser[] {
  const out: InstalledBrowser[] = [
    { id: 'builtin', name: NAMES.builtin },
    { id: 'default', name: NAMES.default },
  ];
  const cands = candidatePaths(platform, env);
  for (const id of ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'] as BrowserId[]) {
    const hit = (cands[id] ?? []).find((p) => {
      try {
        return exists(p);
      } catch {
        return false;
      }
    });
    if (hit) out.push({ id, name: NAMES[id], path: hit });
  }
  return out;
}

/** http(s) only, parsed and re-serialised (never starts with "-", so never a flag). */
export function safeExternalUrl(input: string): string | null {
  try {
    const u = new URL(String(input ?? '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The process to start for an installed browser (no shell involved). */
export function launchCommand(platform: NodeJS.Platform, browser: InstalledBrowser, url: string): { command: string; args: string[] } | null {
  if (!browser.path) return null;
  if (platform === 'darwin') return { command: 'open', args: ['-a', browser.path, url] };
  return { command: browser.path, args: [url] };
}
