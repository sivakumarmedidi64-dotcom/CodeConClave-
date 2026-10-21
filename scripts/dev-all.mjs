#!/usr/bin/env node
/**
 * CodeConClave — start everything for local development with ONE command:
 *
 *   node scripts/dev-all.mjs            (or double-click start-dev.cmd on Windows)
 *
 *   1. checks the .env file is there (database settings live in it)
 *   2. applies database migrations
 *   3. starts the API (http://localhost:4000), the web app (http://localhost:5173)
 *      and the demo MCP server (http://127.0.0.1:8765/mcp)
 *   4. opens the web app in your browser when it is ready
 *
 * Options: --no-mcp-demo  --no-open  --skip-migrate
 * Ctrl+C stops everything. Uses node directly (no npm shims needed).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const TSX = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const isWin = process.platform === 'win32';

const colors = { api: '\x1b[36m', web: '\x1b[35m', mcp: '\x1b[33m', run: '\x1b[32m' };
const reset = '\x1b[0m';
let stopping = false;
const say = (tag, line) => process.stdout.write(`${colors[tag] ?? ''}[${tag}]${reset} ${line}\n`);

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n\n`);
  process.exit(1);
}

// 1. Preconditions — explain, never guess.
for (const [file, hint] of [
  [TSX, 'Dependencies are missing. Run "npm install" (or "npm ci") in the project folder first.'],
  [VITE, 'Dependencies are missing. Run "npm install" (or "npm ci") in the project folder first.'],
]) {
  if (!existsSync(file)) fail(hint);
}
if (!existsSync(path.join(root, '.env'))) {
  fail(
    `No .env file in ${root}\n  The API reads its settings (database, keys) from .env in this folder.\n` +
      '  Copy your existing .env here (or create one from .env.example), then run this again.',
  );
}

// 2. Migrations (same as "npm run db:migrate").
if (!args.has('--skip-migrate')) {
  say('run', 'Updating the database (migrations)…');
  const m = spawnSync(process.execPath, [TSX, 'src/database/migrate.ts', 'up'], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
  if (m.status !== 0) fail('Database update failed (see above). Check DATABASE_URL in .env and that the database is running.');
}

// 3. Start the three processes.
const children = [];
function start(tag, cmdArgs, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, cmdArgs, { cwd, env: { ...process.env, ...extraEnv, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) say(tag, l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (!stopping) say(tag, `stopped (exit ${code ?? 'signal'})`);
  });
  children.push(child);
  return child;
}

start('api', [TSX, 'watch', 'src/server.ts'], path.join(root, 'backend'));
start('web', [VITE, '--config', 'vite.config.ts'], path.join(root, 'frontend'));
if (!args.has('--no-mcp-demo')) start('mcp', [TSX, 'src/scripts/mcp-demo-server.ts'], path.join(root, 'backend'));

// 4. Wait until the web app and API answer, then say where to go.
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** The API is ready when /health ANSWERS (any status) — an open port alone can hide a stuck API. */
async function apiAnswers() {
  try {
    const res = await fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(5_000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

const started = Date.now();
(async () => {
  while (Date.now() - started < 180_000) {
    if ((await portOpen(5173)) && (await apiAnswers())) {
      const lines = [
        'CodeConClave is running:',
        '  Web app   http://localhost:5173',
        '  API       http://localhost:4000',
        ...(args.has('--no-mcp-demo') ? [] : ['  MCP demo  http://127.0.0.1:8765/mcp  (Settings → Customize → MCP servers → "Use the demo server")']),
        'Press Ctrl+C to stop everything.',
      ];
      process.stdout.write(`\n${colors.run}${lines.join('\n')}${reset}\n\n`);
      if (!args.has('--no-open')) {
        const opener = isWin ? ['cmd', ['/c', 'start', '', 'http://localhost:5173']] : process.platform === 'darwin' ? ['open', ['http://localhost:5173']] : ['xdg-open', ['http://localhost:5173']];
        spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  say('run', 'The web app or API is not answering after 3 minutes. Read the [api] and [web] lines above (often: the database in .env is not reachable).');
})();

// Ctrl+C: stop every child (and their children on Windows).
function stopAll() {
  if (stopping) return;
  stopping = true;
  say('run', 'Stopping…');
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
