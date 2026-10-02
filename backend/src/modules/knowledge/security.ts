/**
 * CodeConClave — Knowledge Security (PKG-12).
 * URL validation, SSRF protection, response size limits, prompt injection resistance.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../config/env.js';

const BLOCKED_HOSTS = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal', // GCP metadata
  '169.254.169.254', // Azure metadata
]);

const BLOCKED_PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

const ALLOWED_SCHEMES = new Set(['https:', 'http:']);
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;

const SUSPICIOUS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /javascript:/gi,
  /data:text\/html/gi,
  /on\w+\s*=/gi,
  /eval\s*\(/gi,
  /Function\s*\(/gi,
];

export interface ValidatedUrl {
  url: string;
  hostname: string;
  isAllowed: boolean;
  reason?: string;
}

export interface FetchOptions {
  maxSize?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface FetchResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  redirected?: boolean;
  finalUrl?: string;
  responseSize?: number;
}

export function validateUrl(url: string, opts: { allowedHosts?: string[]; blockedHosts?: string[] } = {}): ValidatedUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, hostname: '', isAllowed: false, reason: 'Invalid URL format' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { url, hostname: parsed.hostname, isAllowed: false, reason: `Scheme ${parsed.protocol} not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const blocked = new Set([...BLOCKED_HOSTS, ...(opts.blockedHosts ?? [])]);
  if (blocked.has(hostname)) {
    return { url, hostname, isAllowed: false, reason: `Host ${hostname} is blocked` };
  }

  for (const range of BLOCKED_PRIVATE_RANGES) {
    if (range.test(hostname)) {
      return { url, hostname, isAllowed: false, reason: `Private IP range ${hostname} is blocked (SSRF protection)` };
    }
  }

  const allowed = opts.allowedHosts ?? [];
  if (allowed.length > 0 && !allowed.some(h => hostname === h || hostname.endsWith(`.${h}`))) {
    return { url, hostname, isAllowed: false, reason: `Host ${hostname} not in allowlist` };
  }

  return { url, hostname, isAllowed: true };
}

export function sanitizeHtmlContent(content: string, maxLength = 100000): string {
  let sanitized = content;

  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  sanitized = sanitized.replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>"']+)/gi, '');
  sanitized = sanitized.replace(/javascript:/gi, '');
  sanitized = sanitized.replace(/data:text\/html/gi, '');

  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + '... [truncated]';
  }

  return sanitized;
}

export function detectPromptInjection(content: string): { detected: boolean; patterns: string[] } {
  const detectedPatterns: string[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      detectedPatterns.push(pattern.source);
    }
  }
  return { detected: detectedPatterns.length > 0, patterns: detectedPatterns };
}

export async function safeFetch<T = string>(
  url: string,
  opts: FetchOptions = {}
): Promise<FetchResult<T>> {
  const validation = validateUrl(url, {
    allowedHosts: opts.allowedHosts,
    blockedHosts: opts.blockedHosts,
  });

  if (!validation.isAllowed) {
    return { ok: false, error: validation.reason ?? 'URL validation failed', statusCode: 400 };
  }

  const maxSize = opts.maxSize ?? MAX_RESPONSE_SIZE;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let redirectCount = 0;
  let currentUrl = url;
  let finalUrl = url;
  let responseSize = 0;

  try {
    while (redirectCount <= maxRedirects) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'CodeConClave-KnowledgeBot/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
      });

      finalUrl = response.url;

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status,
          finalUrl,
        };
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        return {
          ok: false,
          error: `Response too large: ${contentLength} bytes (max ${maxSize})`,
          statusCode: 413,
          finalUrl,
        };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: false, error: 'No response body', statusCode: 500, finalUrl };
      }

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        responseSize += value.length;
        if (responseSize > maxSize) {
          return {
            ok: false,
            error: `Response exceeded max size of ${maxSize} bytes`,
            statusCode: 413,
            finalUrl,
            responseSize,
          };
        }
      }

      const buffer = Buffer.concat(chunks);
      const text = new TextDecoder().decode(buffer);

      if (text.includes('text/html')) {
        return { ok: true, data: sanitizeHtmlContent(text) as T, finalUrl, responseSize };
      }

      return { ok: true, data: text as T, finalUrl, responseSize };
    }

    return { ok: false, error: 'Max redirects exceeded', statusCode: 310, finalUrl };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Request timeout', statusCode: 408, finalUrl };
    }
    logger.warn('knowledge.safe_fetch_failed', { url, error: (err as Error).message });
    return { ok: false, error: (err as Error).message, statusCode: 500, finalUrl };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function sanitizeForCitation(text: string, maxLength = 500): string {
  return sanitizeHtmlContent(text, maxLength).trim();
}

export function extractTitleFromHtml(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim();
}

export function extractMetaDescription(html: string): string | undefined {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match?.[1]?.trim();
}