/**
 * CodeConClave — API client.
 * Every /api/v1 JSON handler responds { data: payload }; errors respond
 * { error: { code, message, details? } } with the matching HTTP status.
 * State-changing calls echo the CSRF cookie in X-CSRF-Token (double-submit).
 * Session cookie cc_session is httpOnly; the CSRF cookie is readable.
 */
import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )codeconclave_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: boolean;
  /** Phase 16: server-side dedupe for offline sync (Idempotency-Key header). */
  idempotencyKey?: string;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...opts.headers };
  const isStateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (isStateChanging) headers['X-CSRF-Token'] = csrfToken();
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body:
      opts.body instanceof FormData
        ? opts.body
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
  });
  const body = opts.raw ? null : ((await res.json().catch(() => null)) as
    | { data?: T; error?: ApiErrorBody }
    | null);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return (body?.data ?? (body as unknown)) as T;
}

/** Binary fetch for file downloads (GET /api/v1/files/:id/content). */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    throw new ApiError(res.status, err?.error?.code ?? 'http_error', err?.error?.message ?? `Download failed (${res.status})`);
  }
  return res.blob();
}

/** Health endpoint (no envelope, outside /api/v1). */
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'NOT_CONFIGURED';

export interface HealthCheck {
  id: string;
  name: string;
  status: HealthState;
  reason: string | null;
  /** Critical checks are required to serve; optional ones never fail the rollup when merely unconfigured. */
  critical?: boolean;
}

export interface Health {
  status: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  ok: boolean;
  name: string;
  provider: string;
  queue: string;
  time: string;
  checks?: HealthCheck[];
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/health', { credentials: 'same-origin' });
  return (await res.json()) as Health;
}

/** Upload support: projectId + path become form fields alongside files. */
export function uploadForm(
  files: File[],
  fields: Record<string, string>,
): FormData {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

// ---------------------------------------------------------------- cowork share links
import type { ShareMode, ShareLinkView } from './types';

export async function createShareLink(
  conversationId: string,
  mode: ShareMode,
  opts: { oneTime?: boolean; expiresInMs?: number } = {},
): Promise<ShareLinkView> {
  const res = await api<{ shareLink: ShareLinkView }>(`/api/v1/conversations/${conversationId}/share-links`, {
    method: 'POST',
    body: { mode, ...opts },
  });
  return res.shareLink;
}

export async function listShareLinks(conversationId: string): Promise<ShareLinkView[]> {
  const res = await api<{ shareLinks: ShareLinkView[] }>(`/api/v1/conversations/${conversationId}/share-links`);
  return res.shareLinks ?? [];
}

export async function revokeShareLink(conversationId: string, token: string): Promise<void> {
  await api(`/api/v1/conversations/${conversationId}/share-links/${token}`, { method: 'DELETE' });
}