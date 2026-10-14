/**
 * CodeConClave Desktop — copy the built SPA (frontend/dist + server.cjs) into
 * desktop/resources/frontend so electron-builder ships it as extraResources.
 * Run AFTER a frontend workspace build. Dev mode uses the repo frontend dir
 * directly (see electron/spa-server.ts).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyFrontend(srcDist, srcServer, dest) {
  if (!existsSync(srcDist)) throw new Error('frontend/dist missing — build the frontend first.');
  if (!existsSync(srcServer)) throw new Error('frontend/server.cjs missing.');

  const destDist = join(dest, 'dist');
  rmSync(destDist, { recursive: true, force: true });
  mkdirSync(destDist, { recursive: true });
  cpSync(srcDist, destDist, { recursive: true, force: true });
  cpSync(srcServer, join(dest, 'server.cjs'));
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..');
  const srcFrontend = join(repoRoot, 'frontend');
  const dest = join(repoRoot, 'desktop', 'resources', 'frontend');
  try {
    copyFrontend(join(srcFrontend, 'dist'), join(srcFrontend, 'server.cjs'), dest);
    console.log(`[copy-frontend] bundled SPA -> ${dest}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown copy error';
    console.error(`[copy-frontend] ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
