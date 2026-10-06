/**
 * CodeConClave — terminal session persistence (Phase 4B).
 * Stores only what the paired local agent reports: status transitions and the
 * real pid arrive over the authenticated /agent socket and are mirrored here.
 * History is append-only per channel and searchable (ILIKE + tsvector index).
 */
import type { TerminalState } from '@codeconclave/shared';
import { pool, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { redactSecrets } from '../secretGuard/patterns.js';

const MAX_LINE_TEXT = 65_536;

export interface TerminalSessionRow {
  id: string;
  owner_id: string;
  device_id: string;
  tab_id: string;
  shell: string;
  cwd: string | null;
  status: TerminalState;
  pid: number | null;
  exit_code: number | null;
  timeout_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export async function insertTerminalSession(input: {
  id: string;
  ownerId: string;
  deviceId: string;
  tabId: string;
  shell: string;
  cwd: string | null;
  timeoutMs: number | null;
}): Promise<void> {
  await withTenant(input.ownerId, (q) => q.query(
    `INSERT INTO terminal_sessions (id, owner_id, device_id, tab_id, shell, cwd, status, timeout_ms)
     VALUES ($1,$2,$3,$4,$5,$6,'PLANNED',$7)`,
    [input.id, input.ownerId, input.deviceId, input.tabId, input.shell, input.cwd, input.timeoutMs],
  ));
}

/** Mirror an agent-reported status event onto the persisted session. */
export async function updateTerminalStatus(
  ownerId: string,
  tabId: string,
  status: TerminalState,
  exitCode: number | null,
  pid: number | null,
): Promise<void> {
  await withTenant(ownerId, (q) => q.query(
    `UPDATE terminal_sessions
     SET status = $2,
         exit_code = $3,
         pid = CASE WHEN $2 IN ('PLANNED','STARTING','RUNNING') THEN $4 ELSE NULL END,
         started_at = CASE
           WHEN $2 IN ('STARTING','RUNNING') AND started_at IS NULL THEN now()
           ELSE started_at
         END,
         ended_at = CASE
           WHEN $2 IN ('COMPLETED','FAILED','KILLED','TIMED_OUT') THEN now()
           ELSE NULL
         END
     WHERE tab_id = $5 AND owner_id = $1`,
    [ownerId, status, exitCode, pid, tabId],
  ));
}

export async function appendTerminalHistory(
  ownerId: string,
  tabId: string,
  channel: 'stdout' | 'stderr' | 'input' | 'status',
  text: string,
): Promise<void> {
  if (!text) return;
  // Redact BEFORE persistence: secrets visible in a terminal (API keys,
  // tokens, connection strings, private keys) must never reach the store.
  const safe = redactSecrets(text);
  if (!safe) return;
  await withTenant(ownerId, (q) => q.query(
    `INSERT INTO terminal_history (id, session_id, channel, text, seq)
     SELECT $1, s.id, $3, $4,
            COALESCE((SELECT MAX(seq) FROM terminal_history h WHERE h.session_id = s.id), 0) + 1
     FROM terminal_sessions s
     WHERE s.tab_id = $2 AND s.owner_id = $5`,
    [newId(PREFIX.TERMINAL_LINE), tabId, channel, safe.slice(0, MAX_LINE_TEXT), ownerId],
  ));
}

export async function getTerminalSession(ownerId: string, id: string): Promise<TerminalSessionRow | null> {
  const result = await withTenant(ownerId, (q) => q.query(
    `SELECT id, owner_id, device_id, tab_id, shell, cwd, status, pid, exit_code,
            timeout_ms, started_at, ended_at, created_at
     FROM terminal_sessions WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  ));
  return (result.rows[0] as TerminalSessionRow | undefined) ?? null;
}

export async function listTerminalSessions(ownerId: string, limit: number): Promise<TerminalSessionRow[]> {
  const result = await withTenant(ownerId, (q) => q.query(
    `SELECT id, owner_id, device_id, tab_id, shell, cwd, status, pid, exit_code,
            timeout_ms, started_at, ended_at, created_at
     FROM terminal_sessions WHERE owner_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [ownerId, limit],
  ));
  return result.rows as TerminalSessionRow[];
}

export interface HistoryLine {
  id: string;
  channel: string;
  text: string;
  seq: number;
  createdAt: string;
}

export async function terminalHistoryLines(ownerId: string, sessionId: string, limit: number): Promise<HistoryLine[]> {
  const result = await withTenant(ownerId, (q) => q.query(
    `SELECT h.id, h.channel, h.text, h.seq, h.created_at
     FROM terminal_history h
     JOIN terminal_sessions s ON s.id = h.session_id
     WHERE h.session_id = $1 AND s.owner_id = $2
     ORDER BY h.seq ASC LIMIT $3`,
    [sessionId, ownerId, limit],
  ));
  return result.rows as HistoryLine[];
}

export async function terminalLogs(ownerId: string, sessionId: string, limit = 5000): Promise<string> {
  const result = await withTenant(ownerId, (q) => q.query(
    `SELECT h.text
     FROM terminal_history h
     JOIN terminal_sessions s ON s.id = h.session_id
     WHERE h.session_id = $1 AND s.owner_id = $2
     ORDER BY h.seq ASC LIMIT $3`,
    [sessionId, ownerId, limit],
  ));
  return result.rows.map((r) => r.text as string).join('');
}

export async function searchTerminalHistory(ownerId: string, q: string, limit: number): Promise<HistoryLine[]> {
  const result = await withTenant(ownerId, (w) => w.query(
    `SELECT h.id, h.channel, h.text, h.seq, h.created_at
     FROM terminal_history h
     JOIN terminal_sessions s ON s.id = h.session_id
     WHERE s.owner_id = $1 AND h.text ILIKE '%' || $2 || '%'
     ORDER BY h.created_at DESC LIMIT $3`,
    [ownerId, q.replace(/%/g, '\\%').replace(/_/g, '\\_'), limit],
  ));
  return result.rows as HistoryLine[];
}

/** Owner-scoped session lookup for dispatch decisions (device + status only). */
export async function terminalSessionOwner(ownerId: string, id: string): Promise<{ device_id: string; status: TerminalState } | null> {
  const result = await withTenant(ownerId, (q) => q.query(
    'SELECT device_id, status FROM terminal_sessions WHERE id = $1 AND owner_id = $2',
    [id, ownerId],
  ));
  return (result.rows[0] as { device_id: string; status: TerminalState } | undefined) ?? null;
}
