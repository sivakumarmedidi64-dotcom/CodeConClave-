/**
 * CodeConClave — Google adapter (Phase 10).
 * Reuses the EXISTING Google OAuth application (same client id/secret and the
 * registered redirect URI; the auth callback routes plugin states to this
 * flow). Enabled APIs: Gmail, Drive, Sheets, Calendar. Refresh/access tokens
 * are stored server-side encrypted and never exposed to the frontend.
 * Every action enforces its provider OAuth scope against the scopes granted
 * at connect time.
 */
import { z } from 'zod';
import { env, enabledGoogleScopes } from '../../../config/env.js';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com' + '/calendar/v3/calendars/primary' + '/events';

const str = z.string().min(1).max(500);

async function refreshAccessToken(creds: PluginCredentials): Promise<string> {
  const refreshToken = creds.kinds['refresh_token'];
  if (!refreshToken) throw AppError.badRequest('plugin_reauth_required', 'Google reauthorization is required');
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: outboundSignal(),
  });
  if (!response.ok) throw AppError.badRequest('google_token_refresh_failed', 'Google token refresh failed');
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw AppError.badRequest('google_token_refresh_failed', 'Google token refresh failed');
  return payload.access_token;
}

async function googleFetch(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('google_scope_denied', 'Google rejected the token (insufficient or revoked OAuth scope)');
  }
  if (!response.ok) throw new Error(`Google API error (${response.status})`);
  return response.json();
}

function scopesGranted(creds: PluginCredentials): string[] {
  try {
    const raw = creds.kinds['oauth_scopes'] ?? '[]';
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function requireOAuthScope(creds: PluginCredentials, required: string): void {
  if (!required) return;
  const granted = scopesGranted(creds);
  if (!granted.includes(required)) {
    throw AppError.forbidden('oauth_scope_denied', `The connected Google account lacks the required OAuth scope: ${required}`);
  }
}

function oauthAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: enabledGoogleScopes.join(' '),
    access_type: 'offline',
    prompt: env.GOOGLE_OAUTH_CONSENT_MODE,
    state,
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export const googleAdapter: PluginAdapter = {
  id: 'google',
  name: 'Google Workspace',
  provider: 'googleapis.com',
  version: '1.0.0',
  capabilities: [PluginCapability.GMAIL, PluginCapability.DRIVE, PluginCapability.SHEETS, PluginCapability.CALENDAR],
  oauth: { required: true, scopes: enabledGoogleScopes },
  actions: [
    {
      name: 'gmail.messages.list',
      permission: PluginPermission.READ,
      scope: 'gmail:read',
      oauthScope: 'https://www.googleapis.com/auth/gmail.send',
      idempotent: true,
      description: 'Search Gmail messages (metadata only, foundation).',
      inputSchema: z.object({ query: z.string().max(500).optional(), maxResults: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'gmail.messages.get',
      permission: PluginPermission.READ,
      scope: 'gmail:read',
      oauthScope: 'https://www.googleapis.com/auth/gmail.send',
      idempotent: true,
      description: 'Message metadata for one message id.',
      inputSchema: z.object({ id: str, format: z.enum(['metadata', 'minimal']).default('metadata') }),
    },
    {
      name: 'gmail.send',
      permission: PluginPermission.SEND,
      scope: 'gmail:send',
      oauthScope: 'https://www.googleapis.com/auth/gmail.send',
      idempotent: true,
      description: 'Authorized send foundation: compose + send a message (idempotency key supported).',
      inputSchema: z.object({
        to: z.array(str).min(1).max(50),
        subject: str,
        body: str,
        fromName: str.optional(),
        idempotencyKey: str.optional(),
      }),
    },
    {
      name: 'drive.files.list',
      permission: PluginPermission.READ,
      scope: 'drive:read',
      oauthScope: 'https://www.googleapis.com/auth/drive.file',
      idempotent: true,
      description: 'List Drive files (authorized read foundation).',
      inputSchema: z.object({ query: str.optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'drive.files.get',
      permission: PluginPermission.READ,
      scope: 'drive:read',
      oauthScope: 'https://www.googleapis.com/auth/drive.file',
      idempotent: true,
      description: 'Drive file metadata by id.',
      inputSchema: z.object({ fileId: str }),
    },
    {
      name: 'drive.files.create',
      permission: PluginPermission.WRITE,
      scope: 'drive:write',
      oauthScope: 'https://www.googleapis.com/auth/drive.file',
      idempotent: false,
      description: 'Authorized write foundation: create a Drive file.',
      inputSchema: z.object({ name: str, mimeType: z.enum(['text/plain', 'application/json', 'text/markdown']).default('text/plain'), content: str }),
    },
    {
      name: 'sheets.spreadsheets.list',
      permission: PluginPermission.READ,
      scope: 'sheets:read',
      oauthScope: 'https://www.googleapis.com/auth/spreadsheets',
      idempotent: true,
      description: 'List spreadsheets the app can see.',
      inputSchema: z.object({ pageSize: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'sheets.values.get',
      permission: PluginPermission.READ,
      scope: 'sheets:read',
      oauthScope: 'https://www.googleapis.com/auth/spreadsheets',
      idempotent: true,
      description: 'Read a spreadsheet range.',
      inputSchema: z.object({ spreadsheetId: str, range: str }),
    },
    {
      name: 'sheets.values.append',
      permission: PluginPermission.WRITE,
      scope: 'sheets:write',
      oauthScope: 'https://www.googleapis.com/auth/spreadsheets',
      idempotent: false,
      description: 'Append rows to a spreadsheet (authorized write).',
      inputSchema: z.object({ spreadsheetId: str, range: str, values: z.array(z.array(z.string().nullable())).min(1) }),
    },
    {
      name: 'calendar.events.list',
      permission: PluginPermission.READ,
      scope: 'calendar:read',
      oauthScope: 'https://www.googleapis.com/auth/calendar.events',
      idempotent: true,
      description: 'List upcoming calendar events.',
      inputSchema: z.object({ maxResults: z.coerce.number().int().min(1).max(100).optional(), timeMin: str.optional() }),
    },
    {
      name: 'calendar.events.create',
      permission: PluginPermission.CREATE,
      scope: 'calendar:write',
      oauthScope: 'https://www.googleapis.com/auth/calendar.events',
      idempotent: false,
      description: 'Create a calendar event (approval-gated by policy).',
      inputSchema: z.object({
        summary: str,
        description: str.optional(),
        start: str,
        end: str,
        attendees: z.array(str).max(50).optional(),
      }),
    },
  ],
  authenticate: async (ctx, creds) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw AppError.unavailable('google_not_configured', 'Google OAuth is not configured on the server');
    }
    if (!creds.kinds['refresh_token']) throw AppError.badRequest('plugin_reauth_required', 'Google reauthorization is required');
    await refreshAccessToken(creds);
  },
  healthCheck: async (ctx, creds) => {
    const start = Date.now();
    try {
      if (!creds.kinds['refresh_token']) return { ok: false, latencyMs: Date.now() - start, detail: 'reauth_required' };
      const token = await refreshAccessToken(creds);
      await googleFetch(token, 'https://www.googleapis.com/oauth2/v3/userinfo');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, detail: 'google_unreachable' };
    }
  },
  execute: async (ctx, creds, action, input) => {
    const start = Date.now();
    if (!action.oauthScope) throw AppError.badRequest('plugin_action_unknown', `Unknown Google action: ${action.name}`);
    requireOAuthScope(creds, action.oauthScope);
    const token = await refreshAccessToken(creds);
    const data = await googleActionFetch(token, action.name, input);
    return { ok: true, data, latencyMs: Date.now() - start };
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};

async function googleActionFetch(token: string, action: string, input: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'gmail.messages.list': {
      const q = input.query ? String(input.query) : '';
      const max = input.maxResults !== undefined ? Number(input.maxResults) : 20;
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages${q ? `?q=${encodeURIComponent(q)}` : ''}${q ? '' : '?'}${q ? '&' : '?'}maxResults=${max}`;
      return googleFetch(token, url);
    }
    case 'gmail.messages.get': {
      const format = String(input.format ?? 'metadata');
      return googleFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(String(input.id))}?format=${format}`);
    }
    case 'gmail.send': {
      const to = (input.to as string[]).join(', ');
      const subject = String(input.subject);
      const body = String(input.body);
      // Gmail rewrites From to the authenticated account address.
      const raw = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(input.idempotencyKey ? { 'Idempotency-Key': String(input.idempotencyKey) } : {}),
        },
        body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
        signal: outboundSignal(),
      });
      if (!response.ok) throw new Error(`Gmail send failed (${response.status})`);
      return response.json();
    }
    case 'drive.files.list': {
      const query = input.query ? `&q=${encodeURIComponent(String(input.query))}` : '';
      const size = input.pageSize !== undefined ? Number(input.pageSize) : 20;
      return googleFetch(token, `https://www.googleapis.com/drive/v3/files?pageSize=${size}${query}&fields=files(id,name,mimeType,size,modifiedTime)`);
    }
    case 'drive.files.get':
      return googleFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(input.fileId))}?fields=id,name,mimeType,size,modifiedTime`);
    case 'drive.files.create': {
      const response = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=media&fields=id,name,mimeType`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': String(input.mimeType ?? 'text/plain') },
          body: String(input.content),
          signal: outboundSignal(),
        },
      );
      if (!response.ok) throw new Error(`Drive create failed (${response.status})`);
      return response.json();
    }
    case 'sheets.spreadsheets.list':
      return googleFetch(token, `https://sheets.googleapis.com/v4/spreadsheets?pageSize=${input.pageSize !== undefined ? Number(input.pageSize) : 20}`);
    case 'sheets.values.get':
      return googleFetch(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(input.spreadsheetId))}/values/${encodeURIComponent(String(input.range))}`,
      );
    case 'sheets.values.append': {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(input.spreadsheetId))}/values/${encodeURIComponent(String(input.range))}:append?valueInputOption=RAW`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: input.values }),
          signal: outboundSignal(),
        },
      );
      if (!response.ok) throw new Error(`Sheets append failed (${response.status})`);
      return response.json();
    }
    case 'calendar.events.list': {
      const max = input.maxResults !== undefined ? Number(input.maxResults) : 20;
      const timeMin = input.timeMin ? `&timeMin=${encodeURIComponent(String(input.timeMin))}` : '';
      return googleFetch(token, `${GOOGLE_CALENDAR_API}?maxResults=${max}${timeMin}`);
    }
    case 'calendar.events.create': {
      const response = await fetch(GOOGLE_CALENDAR_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: String(input.summary),
          description: input.description ? String(input.description) : undefined,
          start: { dateTime: String(input.start) },
          end: { dateTime: String(input.end) },
          attendees: input.attendees ? (input.attendees as string[]).map((email) => ({ email })) : undefined,
        }),
        signal: outboundSignal(),
      });
      if (!response.ok) throw new Error(`Calendar create failed (${response.status})`);
      return response.json();
    }
    default:
      throw AppError.badRequest('plugin_action_unknown', `Unknown Google action: ${action}`);
  }
}

export { oauthAuthorizeUrl as googlePluginAuthorizeUrl };