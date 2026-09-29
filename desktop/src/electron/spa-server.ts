/**
 * CodeConClave Desktop — embedded web UI server (main process).
 * Serves the packaged frontend (server.cjs + dist) on the local origin
 * http://localhost:8080 so a clean Windows install runs the same web UI with
 * no dev server and no hosted origin. /api and /health are proxied by
 * server.cjs to the local backend origin http://localhost:4000; the desktop
 * shell only ever talks to the 8080 origin.
 *
 * The child is launched through the running Electron binary with
 * ELECTRON_RUN_AS_NODE=1, so packaging stays dependency-free (server.cjs only
 * uses Node core modules). Loaded from the unpacked extraResources copy in
 * production, or the repo frontend dir in dev.
 */
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const EMBEDDED_ORIGIN = 'http://localhost:8080';

/** Hosted production backend. Packaged installs reach it directly; the override
 *  CC_DESKTOP_BACKEND_URL always wins; un-packaged dev builds stay local. */
export const HOSTED_BACKEND_URL = 'https://codeconclave-api.onrender.com';

/** Default proxy target = the hosted backend for packaged production installs,
 *  the local backend for dev (mirrors the web app exactly: sign-in, no-free-tier
 *  gate, payment popup). Override explicitly with CC_DESKTOP_BACKEND_URL. */
export const PROXY_TARGET =
  process.env.CC_DESKTOP_BACKEND_URL ||
  (app.isPackaged ? HOSTED_BACKEND_URL : 'http://localhost:4000');
const READY_TIMEOUT_MS = 15_000;
const READY_INTERVAL_MS = 250;

/** Packaged payload lives at process.resourcesPath/frontend (extraResources). */
function frontendDir(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'frontend');
    if (existsSync(join(packaged, 'server.cjs')) && existsSync(join(packaged, 'dist'))) return packaged;
  }
  const dev = resolve(__dirname, '../../../frontend');
  if (existsSync(join(dev, 'server.cjs')) && existsSync(join(dev, 'dist'))) return dev;
  return null;
}

function isEmbeddedOrigin(appUrl: string): boolean {
  try {
    return new URL(appUrl).origin === new URL(EMBEDDED_ORIGIN).origin;
  } catch {
    return false;
  }
}

function waitUntilAlive(base: string): Promise<void> {
  return new Promise((resolve_ready, reject) => {
    const started = Date.now();
    const attempt = () => {
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve_ready();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > READY_TIMEOUT_MS) {
        reject(new Error(`embedded web UI did not become ready on ${EMBEDDED_ORIGIN}`));
        return;
      }
      setTimeout(attempt, READY_INTERVAL_MS);
    };
    attempt();
  });
}

export async function ensureEmbeddedApp(
  appUrl: string,
  log: (line: string) => void = () => {},
): Promise<{ url: string; stop: () => void } | null> {
  if (!isEmbeddedOrigin(appUrl)) return null;

  const dir = frontendDir();
  if (!dir) {
    throw new Error('Embedded web UI not found (frontend/dist + server.cjs). Run the frontend build and `npm run build` in the desktop workspace first.');
  }

  const child: ChildProcess = spawn(process.execPath, [join(dir, 'server.cjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '8080',
      FRONTEND_PROXY_TARGET: PROXY_TARGET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => log(`[spa] ${String(d).toString().trimEnd()}`));
  child.stderr?.on('data', (d) => log(`[spa] ${String(d).toString().trimEnd()}`));

  try {
    await waitUntilAlive(EMBEDDED_ORIGIN);
  } catch (err) {
    if (child.exitCode === null) child.kill();
    throw err;
  }

  return {
    url: EMBEDDED_ORIGIN,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}