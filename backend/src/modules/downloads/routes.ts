/**
 * CodeConClave — public desktop installer download routes.
 * Serves the packaged Windows installer (desktop/release/*.exe) to visitors
 * from the landing page. Public + read-only (GET only, no user input in the
 * resolved path — the directory is computed from the repo layout, never from
 * request params). Returns honest 404 JSON when no installer is published.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { asyncRoute } from '../../middleware/security.js';

const DEFAULT_SETUP_DIR = fileURLToPath(new URL('../../../../desktop/release/', import.meta.url));

export interface DesktopInstallInfo {
  fileName: string;
  version: string;
  sizeBytes: number;
}

/** Find the newest packaged installer in the release directory. */
export async function latestDesktopInstall(dir: string): Promise<DesktopInstallInfo | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const exes = entries.filter((n) => /^CodeConClave Setup .+\.exe$/i.test(n));
  if (exes.length === 0) return null;
  exes.sort((a, b) => b.localeCompare(a));
  const fileName = exes[0]!;
  const versionMatch = /(\d+\.\d+\.\d+)/.exec(fileName);
  const version = versionMatch ? versionMatch[1]! : '0.0.0';
  try {
    const s = await stat(join(dir, fileName));
    if (!s.isFile()) return null;
    return { fileName, version, sizeBytes: s.size };
  } catch {
    return null;
  }
}

export function desktopDownloadRoutes(opts: { setupDir?: string } = {}): Router {
  const setupDir = opts.setupDir ?? DEFAULT_SETUP_DIR;
  const router = Router();

  router.get(
    '/info',
    asyncRoute(async (_req, res) => {
      const info = await latestDesktopInstall(setupDir);
      if (!info) {
        res.json({ ok: true, available: false, fileName: null, version: null, sizeBytes: null, sizeMB: null });
        return;
      }
      res.json({
        ok: true,
        available: true,
        fileName: info.fileName,
        version: info.version,
        sizeBytes: info.sizeBytes,
        sizeMB: Number((info.sizeBytes / (1024 * 1024)).toFixed(1)),
      });
    }),
  );

  router.get(
    '/desktop',
    asyncRoute(async (req, res) => {
      const info = await latestDesktopInstall(setupDir);
      if (!info) {
        res.status(404).json({ ok: false, errorCode: 'desktop_installer_unavailable', message: 'No desktop installer is published yet.' });
        return;
      }
      const filePath = join(setupDir, info.fileName);
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Length', String(info.sizeBytes));
      const safeName = `CodeConClave-Setup-${info.version}.exe`;
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('error', (err) => {
        req.destroy(err);
      });
      stream.pipe(res);
    }),
  );

  return router;
}