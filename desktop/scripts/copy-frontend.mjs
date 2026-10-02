/**
 * CodeConClave Desktop — copy the built SPA (frontend/dist + server.cjs) into
 * desktop/resources/frontend so electron-builder ships it as extraResources.
 * Run AFTER a frontend workspace build. Dev mode uses the repo frontend dir
 * directly (see electron/spa-server.ts).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const srcFrontend = join(repoRoot, 'frontend');
const srcDist = join(srcFrontend, 'dist');
const srcServer = join(srcFrontend, 'server.cjs');
const dest = join(repoRoot, 'desktop', 'resources', 'frontend');

if (!existsSync(srcDist)) {
  console.error('[copy-frontend] frontend/dist missing — run `npm run build --workspace @codeconclave/frontend` first.');
  process.exit(1);
}
if (!existsSync(srcServer)) {
  console.error('[copy-frontend] frontend/server.cjs missing.');
  process.exit(1);
}

mkdirSync(join(dest, 'dist'), { recursive: true });
cpSync(srcDist, join(dest, 'dist'), { recursive: true, force: true });
cpSync(srcServer, join(dest, 'server.cjs'));
console.log(`[copy-frontend] bundled SPA -> ${dest}`);