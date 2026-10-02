/**
 * CodeConClave — built-in SPA static host.
 *
 * Serves the production frontend bundle (frontend/dist) from the backend, so
 * a single Railway service can host the website AND the API on one origin
 * (same-origin cookies, SSE and WebSockets; no CORS seam). It is additive and
 * OPT-IN: when frontend/dist is not present in the image (dev, tests, worker
 * images), every request falls through to the standard 404 handler exactly as
 * before. Paths under /api are never served by this middleware (API routers
 * are mounted earlier and win anyway; this guard also protects a hypothetical
 * request error that reaches here).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
// backend/src/static -> backend/src -> backend -> repo root
const repoRoot = path.resolve(here, '..', '..', '..');
const DIST = path.join(repoRoot, 'frontend', 'dist');
const INDEX = path.join(DIST, 'index.html');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function spaDistReady(): boolean {
  return existsSync(INDEX);
}

/**
 * Express middleware. Safe to mount unconditionally: without a built bundle it
 * is a no-op (calls next() and the existing 404 handler runs).
 */
export function spaMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const serverFile = INDEX;
  const { method } = _req;
  if (!existsSync(serverFile)) {
    next();
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    next();
    return;
  }
  const rawPath = (_req.path || '/').replace(/\/+$/, '') || '/';
  if (rawPath.startsWith('/api/') || rawPath === '/api') {
    next();
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    res.status(400).json({ error: { code: 'bad_path', message: 'Malformed path' } });
    return;
  }
  if (decoded.includes('\0')) {
    res.status(400).json({ error: { code: 'bad_path', message: 'Malformed path' } });
    return;
  }
  const rel = decoded === '/' ? 'index.html' : decoded.slice(1);
  const filePath = path.normalize(path.join(DIST, rel));
  if (!filePath.startsWith(DIST + path.sep) && filePath !== INDEX) {
    res.status(400).json({ error: { code: 'bad_path', message: 'Malformed path' } });
    return;
  }

  const isFile = existsSync(filePath) ? statSync(filePath).isFile() : false;
  const ext = path.extname(filePath).toLowerCase();

  if (isFile && MIME[ext]) {
    const body = readFileSync(filePath);
    const isAsset = rawPath.startsWith('/assets/');
    res.set({ ...SECURITY_HEADERS, 'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.status(200).set('Content-Type', MIME[ext]).end(body);
    return;
  }
  // SPA fallback: client-only routes (login, register, settings, verify-email,
  // deep links, refresh) re-serve index.html. Directories without an index are
  // 404s; unknown file extensions fall through to the API 404 handler.
  if (!ext) {
    const body = readFileSync(serverFile);
    res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' });
    res.status(200).set('Content-Type', MIME['.html']).end(body);
    return;
  }
  next();
}