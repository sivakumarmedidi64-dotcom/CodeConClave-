/**
 * CodeConClave — PKG-19 runtime — capture boundaries (F38 preview expansion).
 * Console and network events are stored ONLY when a live browser/preview iframe
 * actually forwards them (evidence-based, honest). There is no headless browser
 * in the repo, so these surfaces stay genuinely empty/UNAVAILABLE until real
 * evidence arrives — never fabricated. Network metadata is redacted (sensitive
 * query params stripped; request/response bodies are never persisted by default).
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { ConsoleEvent, ConsoleLevel, NetworkEvent, NetworkState } from './types.js';
import { assertProjectAccess, redactUrl } from './security.js';
import { broadcastRuntime } from './events.js';

const CONSOLE_LEVELS = new Set<string>(['log', 'info', 'warn', 'error', 'debug', 'uncaught']);
const NETWORK_STATES = new Set<string>(['PENDING', 'SUCCESS', 'CLIENT_ERROR', 'SERVER_ERROR', 'TIMED_OUT', 'NETWORK_ERROR', 'BLOCKED']);

function classifyNetwork(status: number | null): NetworkState {
  if (status === null) return 'PENDING';
  if (status >= 500) return 'SERVER_ERROR';
  if (status >= 400) return 'CLIENT_ERROR';
  return 'SUCCESS';
}

export interface ConsoleRow {
  id: string;
  project_id: string;
  level: string;
  message: string;
  stack: string | null;
  source_url: string | null;
  ts: Date;
}

export interface NetworkRow {
  id: string;
  project_id: string;
  method: string;
  url_path: string;
  status: number | null;
  duration_ms: number | null;
  ok: boolean | null;
  state: string;
  request_id: string | null;
  ts: Date;
}

function rowToConsole(r: ConsoleRow): ConsoleEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    level: (CONSOLE_LEVELS.has(r.level) ? r.level : 'log') as ConsoleLevel,
    message: r.message,
    stack: r.stack,
    sourceUrl: r.source_url,
    ts: r.ts.toISOString(),
  };
}

function rowToNetwork(r: NetworkRow): NetworkEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    method: r.method,
    urlPath: r.url_path,
    status: r.status,
    durationMs: r.duration_ms,
    ok: r.ok,
    state: (NETWORK_STATES.has(r.state) ? r.state : 'PENDING') as NetworkState,
    requestId: r.request_id,
    ts: r.ts.toISOString(),
  };
}

export class RuntimeCaptureEngine {
  /** Record a forwarded console event. `sourceToken` proves the capture came
   *  from an initialized iframe (checked by the route via a session marker). */
  async recordConsole(
    userId: string,
    projectId: string,
    level: string,
    message: string,
    stack?: string | null,
    sourceUrl?: string | null,
  ): Promise<ConsoleEvent> {
    await assertProjectAccess(userId, projectId);
    const lvl = (CONSOLE_LEVELS.has(level) ? level : 'log') as ConsoleLevel;
    const id = newId(PREFIX.RUNTIME_CONSOLE_EVENT);
    await withTenant(userId, async (q) =>
      q.query(
        `INSERT INTO runtime_console_events (id, owner_id, project_id, level, message, stack, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, userId, projectId, lvl, String(message ?? '').slice(0, 20000), stack?.slice(0, 20000) ?? null, sourceUrl?.slice(0, 2000) ?? null],
      ),
    );
    broadcastRuntime(projectId, { type: 'capture', projectId, channel: 'console', ts: new Date().toISOString() });
    return this.getConsoleView(userId, id, projectId);
  }

  async recordNetwork(
    userId: string,
    projectId: string,
    method: string,
    url: string,
    status?: number | null,
    durationMs?: number | null,
    requestId?: string | null,
  ): Promise<NetworkEvent> {
    await assertProjectAccess(userId, projectId);
    const redacted = redactUrl(String(url ?? '').slice(0, 2000));
    let pathOnly = redacted;
    try {
      pathOnly = `${new URL(redacted).pathname}`;
    } catch {
      /* keep redacted string */
    }
    const st = typeof status === 'number' ? status : null;
    const state = classifyNetwork(st);
    const id = newId(PREFIX.RUNTIME_NETWORK_EVENT);
    await withTenant(userId, async (q) =>
      q.query(
        `INSERT INTO runtime_network_events (id, owner_id, project_id, method, url_path, status, duration_ms, ok, state, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, userId, projectId, String(method ?? 'GET').toUpperCase().slice(0, 16), pathOnly.slice(0, 2000), st, durationMs, st ? st < 400 : null, state, requestId?.slice(0, 200) ?? null],
      ),
    );
    broadcastRuntime(projectId, { type: 'capture', projectId, channel: 'network', ts: new Date().toISOString() });
    return this.getNetworkView(userId, id, projectId);
  }

  async listConsole(userId: string, projectId: string, limit = 200): Promise<ConsoleEvent[]> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant(userId, async (q) =>
      (await q.query<ConsoleRow>(
        `SELECT * FROM runtime_console_events WHERE project_id = $1 ORDER BY ts DESC LIMIT $2`,
        [projectId, limit],
      )).rows,
    );
    return rows.reverse().map(rowToConsole);
  }

  async listNetwork(userId: string, projectId: string, limit = 200): Promise<NetworkEvent[]> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant(userId, async (q) =>
      (await q.query<NetworkRow>(
        `SELECT * FROM runtime_network_events WHERE project_id = $1 ORDER BY ts DESC LIMIT $2`,
        [projectId, limit],
      )).rows,
    );
    return rows.reverse().map(rowToNetwork);
  }

  async clear(userId: string, projectId: string, channel?: 'console' | 'network'): Promise<void> {
    await assertProjectAccess(userId, projectId);
    await withTenant(userId, async (q) => {
      if (channel === 'console') {
        await q.query(`DELETE FROM runtime_console_events WHERE project_id = $1`, [projectId]);
      } else if (channel === 'network') {
        await q.query(`DELETE FROM runtime_network_events WHERE project_id = $1`, [projectId]);
      } else {
        await q.query(`DELETE FROM runtime_console_events WHERE project_id = $1`, [projectId]);
        await q.query(`DELETE FROM runtime_network_events WHERE project_id = $1`, [projectId]);
      }
    });
  }

  private async getConsoleView(userId: string, id: string, projectId: string): Promise<ConsoleEvent> {
    const rows = await withTenant(userId, async (q) =>
      (await q.query<ConsoleRow>(
        `SELECT * FROM runtime_console_events WHERE id = $1 AND project_id = $2`,
        [id, projectId],
      )).rows,
    );
    if (!rows[0]) throw AppError.notFound('ConsoleEvent');
    return rowToConsole(rows[0]);
  }

  private async getNetworkView(userId: string, id: string, projectId: string): Promise<NetworkEvent> {
    const rows = await withTenant(userId, async (q) =>
      (await q.query<NetworkRow>(
        `SELECT * FROM runtime_network_events WHERE id = $1 AND project_id = $2`,
        [id, projectId],
      )).rows,
    );
    if (!rows[0]) throw AppError.notFound('NetworkEvent');
    return rowToNetwork(rows[0]);
  }
}

export const runtimeCaptureEngine = new RuntimeCaptureEngine();
