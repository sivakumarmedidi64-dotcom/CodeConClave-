/**
 * CodeConClave — tiny cookie parsing (no dependency needed).
 */
import type { Request } from 'express';

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Attach parsed cookies to req.cookies (used by csrf/auth middleware). */
export function cookieParser(req: Request, _res: unknown, next: () => void): void {
  Object.defineProperty(req, 'cookies', {
    value: parseCookies(req),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  next();
}