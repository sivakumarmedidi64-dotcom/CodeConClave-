/**
 * CodeConClave Local Agent — launch a CodeConClave-managed browser session.
 *
 * A fresh Chromium/Edge process with an isolated temp user-data-dir and the
 * debugging port bound to 127.0.0.1 only. The page target is created through
 * the local debugging endpoint; the page websocket (NOT a public CDP endpoint)
 * is what the controller speaks to. The process is not shared with the user's
 * own browsing session: it is clearly a managed, disposable session.
 *
 * Mode 2 (controlling the user's existing authenticated tabs) is NOT
 * implemented and is rejected at the policy layer.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedBrowser } from './types.js';
import { connectCdp } from './cdp.js';

export interface LaunchOptions {
  headless: boolean;
  userDataDir: string;
  downloadDir: string;
  port: number;
  browserPath?: string;
}

/** Candidate Chromium/Edge executable paths for this platform, most-likely first. */
export function candidateBrowserPaths(): string[] {
  const paths: string[] = [];
  if (process.env.CODECONCLAVE_BROWSER_PATH) paths.push(process.env.CODECONCLAVE_BROWSER_PATH);
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES ?? '', process.env['PROGRAMFILES(X86)'] ?? '', process.env.LOCALAPPDATA ?? '']) {
      if (!base) continue;
      paths.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      if (base !== (process.env.LOCALAPPDATA ?? '')) {
        paths.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      }
    }
  } else if (process.platform === 'darwin') {
    paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    paths.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    paths.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return paths;
}

export function findBrowserPath(browserPath?: string): string | null {
  if (browserPath && existsSync(browserPath)) return browserPath;
  for (const p of candidateBrowserPaths()) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export async function launchManagedBrowser(options: LaunchOptions): Promise<ManagedBrowser> {
  const exe = findBrowserPath(options.browserPath);
  if (!exe) throw new Error('browser_not_found: no supported Chromium/Edge found (set CODECONCLAVE_BROWSER_PATH)');
  mkdirSync(options.downloadDir, { recursive: true });

  const args = [
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pings',
    '--mute-audio',
    '--metrics-recording-only',
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
  ];
  if (options.headless) args.push('--headless=new');

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString();
  });

  // Resolve once the process has actually been spawned (or reject cleanly if
  // the executable vanished between `existsSync` and `spawn`). Without this, a
  // spawn failure would surface as an uncaught 'error' event.
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', (err) => reject(err));
    });
  } catch (err) {
    proc.kill();
    throw new Error(`browser_launch_failed: ${err instanceof Error ? err.message : 'spawn error'}`);
  }

  try {
    const endpoint = await waitForDebugEndpoint(options.port, 15_000);
    const page = await createPageTarget(options.port);
    const session = await connectCdp(page.webSocketDebuggerUrl);
    return {
      process: proc,
      browserWsUrl: endpoint.webSocketDebuggerUrl,
      pageId: page.id,
      pageWsUrl: page.webSocketDebuggerUrl,
      session,
      cleanup: async () => {
        try {
          session.close();
        } catch {
          /* already closed */
        }
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
        try {
          rmSync(options.userDataDir, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          /* best-effort temp cleanup */
        }
      },
    };
  } catch (err) {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
    throw err;
  }
}

async function waitForDebugEndpoint(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'never ready';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl: string };
        if (typeof body.webSocketDebuggerUrl === 'string' && body.webSocketDebuggerUrl.startsWith('ws://')) return body;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(150);
  }
  throw new Error(`browser_debug_endpoint_timeout (${lastErr})`);
}

async function createPageTarget(port: number): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) {
    // Older builds accept GET for /json/new.
    const res2 = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`);
    if (!res2.ok) throw new Error(`browser_page_creation_failed (HTTP ${res2.status})`);
    const body2 = (await res2.json()) as { id: string; webSocketDebuggerUrl: string };
    return body2;
  }
  const body = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  if (typeof body.id !== 'string' || typeof body.webSocketDebuggerUrl !== 'string') {
    throw new Error('browser_page_creation_failed (malformed response)');
  }
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}