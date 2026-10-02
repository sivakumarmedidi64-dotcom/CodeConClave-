/**
 * CodeConClave Desktop — backend client (cloud, read-mostly foundation).
 * Talks to the SAME backend the web app uses, with the same session cookie
 * (httpOnly cc_session) for the configured app origin. All reads are GETs in
 * the foundation; state-changing cloud actions (chat, etc.) remain the web
 * UI's job (reused). Network failures are surfaced as `online:false`, never
 * fabricated as data.
 */
export class BackendError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
  }
}

export class OfflineError extends Error {
  readonly code = 'offline';
  constructor(message = 'backend unreachable') {
    super(message);
    this.name = 'OfflineError';
  }
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<ResponseLike>;

export interface ResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export const realFetch: FetchImpl = (url, init) => fetch(url, init);

/**
 * Electron-cookie-aware auth for main-process reads.
 *
 * The desktop shell talks to the SAME backend the embedded web UI uses, but
 * main-process fetch has no cookie jar: the httpOnly cc_session cookie lives
 * in Electron's session cookie store (set through the embedded 8080 origin).
 * Without it, every `GET /api/v1/auth/me` would answer 401 and the entitlement
 * reader would report "free" for a paying customer. So, when running inside
 * the Electron main process, we attach the stored cookies for the target
 * origin before sending. Unit tests (no Electron runtime) are untouched.
 */
async function electronCookiesFor(url: string): Promise<string | null> {
  if (!process.versions?.electron) return null;
  try {
    const { session } = await import('electron');
    const cookies = await session.defaultSession.cookies.get({ url });
    if (!cookies.length) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

export class BackendClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchImpl = realFetch,
  ) {}

  async getJson<T>(path: string): Promise<{ status: number; data: T }> {
    const target = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = await electronCookiesFor(target);
    if (cookie) headers.Cookie = cookie;
    let res: ResponseLike;
    try {
      res = await this.fetchImpl(target, {
        method: 'GET',
        credentials: 'include',
        headers,
      });
    } catch {
      throw new OfflineError();
    }
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!res.status.toString().startsWith('2')) {
      throw new BackendError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `request failed (${res.status})`);
    }
    return { status: res.status, data: (json?.data ?? json) as T };
  }

  /** The configured backend origin the renderer is allowed to host. */
  origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return this.baseUrl;
    }
  }

  /**
   * Model Routing 2026 — compact routing preview for the CURRENT turn.
   * Same endpoint as the web app; the backend is the single authority. No
   * provider secrets or scoring internals ever leave the server.
   */
  async routingPreview(text?: string): Promise<RoutingPreview> {
    const qs = text ? `?text=${encodeURIComponent(text.slice(0, 4000))}` : '';
    const { data } = await this.getJson<{ decision?: RoutingPreview; preferences?: unknown }>(
      `/api/v1/ai/routing${qs}`,
    );
    return (data?.decision ?? {}) as RoutingPreview;
  }
}

export interface RoutingPreview {
  taskType?: string;
  selectedProvider?: string;
  selectedModel?: string;
  reason?: string;
  estimatedCost?: number | null;
  capabilityMatch?: boolean;
  confidence?: 'high' | 'medium' | 'low';
  healthState?: string;
  routingPreference?: string;
  requestedModelHonored?: boolean;
  requestedModelSubstituted?: boolean;
}