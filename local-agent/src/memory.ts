/**
 * CodeConClave Local Agent — device-local memory folder.
 *
 * When the user works, the agent keeps a `CodeConClave/` folder at the root
 * of each granted workspace it touches (auto-created on first activity):
 *   CodeConClave/activity/YYYY-MM-DD.jsonl   local ops log (this device)
 *   CodeConClave/chats/<conversationId>.md   cloud chat transcripts synced down
 *
 * Privacy by construction: activity entries carry paths, hashes, commands,
 * exit codes and byte counts — NEVER file contents, NEVER command output
 * text (which may itself contain secrets), and NEVER credentials. Chat
 * transcripts are stored as markdown so both the user and the AI can read
 * them with the ordinary file.* commands. Everything stays inside the granted
 * workspace (resolveWorkspacePath), and every helper is best-effort: a
 * memory failure must never break the operation it records.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEMORY_DIR_NAME = 'CodeConClave';

function truncate(value: string, max = 2000): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function dayKey(when = new Date()): string {
  return when.toISOString().slice(0, 10);
}

function safeId(value: string): string | null {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

export interface ActivityEntry {
  ts: string;
  kind: 'file_write' | 'command' | 'scan' | 'chat_sync';
  path?: string;
  beforeHash?: string;
  afterHash?: string;
  bytes?: number;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputBytes?: number;
  detail?: string;
}

/** Append one activity entry (best-effort, never throws). */
export function recordLocalActivity(grantRoot: string, entry: Omit<ActivityEntry, 'ts'>): string | null {
  try {
    const dir = join(grantRoot, MEMORY_DIR_NAME, 'activity');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind: entry.kind,
      ...(entry.path ? { path: truncate(entry.path, 500) } : {}),
      ...(entry.beforeHash ? { beforeHash: entry.beforeHash.slice(0, 64) } : {}),
      ...(entry.afterHash ? { afterHash: entry.afterHash.slice(0, 64) } : {}),
      ...(typeof entry.bytes === 'number' ? { bytes: entry.bytes } : {}),
      ...(entry.command ? { command: truncate(entry.command, 500) } : {}),
      ...(typeof entry.exitCode === 'number' || entry.exitCode === null ? { exitCode: entry.exitCode } : {}),
      ...(typeof entry.timedOut === 'boolean' ? { timedOut: entry.timedOut } : {}),
      ...(typeof entry.outputBytes === 'number' ? { outputBytes: entry.outputBytes } : {}),
      ...(entry.detail ? { detail: truncate(entry.detail, 500) } : {}),
    });
    const file = join(dir, `${dayKey()}.jsonl`);
    appendFileSync(file, `${line}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

export interface ChatTurn {
  role: string;
  content: string;
  at?: string;
}

/**
 * Store a cloud chat transcript as markdown (idempotent per conversation).
 * Validates shape + bounds; rejects overlong/anomalous payloads instead of
 * writing partial state.
 */
export function syncChatTranscript(
  grantRoot: string,
  input: { conversationId: string; updatedAt?: string; turns: ChatTurn[] },
): { ok: true; path: string; turns: number } | { ok: false; error: string } {
  const id = safeId(input.conversationId);
  if (!id) return { ok: false, error: 'invalid conversationId (A-Za-z0-9_-, max 128)' };
  if (!Array.isArray(input.turns) || input.turns.length === 0) return { ok: false, error: 'turns must be a non-empty array' };
  if (input.turns.length > 200) return { ok: false, error: 'too many turns (max 200 per sync)' };
  for (const turn of input.turns) {
    if (!turn || typeof turn.content !== 'string') return { ok: false, error: 'every turn needs string content' };
    if (!['user', 'assistant', 'system'].includes(String(turn.role))) return { ok: false, error: `bad turn role: ${String(turn.role).slice(0, 20)}` };
    if (turn.content.length > 8000) return { ok: false, error: 'turn content too large (max 8000 chars)' };
  }
  try {
    const dir = join(grantRoot, MEMORY_DIR_NAME, 'chats');
    mkdirSync(dir, { recursive: true });
    const lines = [
      `# Chat ${id}`,
      ``,
      input.updatedAt ? `Synced: ${truncate(String(input.updatedAt), 60)}` : `Synced: ${new Date().toISOString()}`,
      ``,
      ...input.turns.flatMap((turn) => [`## ${turn.role}${turn.at ? ` (${truncate(String(turn.at), 60)})` : ''}`, ``, turn.content, ``]),
    ];
    const file = join(dir, `${id}.md`);
    writeFileSync(file, lines.join('\n'), 'utf8');
    return { ok: true, path: file, turns: input.turns.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'sync failed' };
  }
}

/** Where this grant's memory folder lives (for tests and diagnostics). */
export function memoryDirFor(grantRoot: string): string {
  return join(grantRoot, MEMORY_DIR_NAME);
}

export function memoryActivityToday(grantRoot: string, when = new Date()): string {
  return join(grantRoot, MEMORY_DIR_NAME, 'activity', `${dayKey(when)}.jsonl`);
}

export function memoryChatFile(grantRoot: string, conversationId: string): string | null {
  const id = safeId(conversationId);
  return id ? join(grantRoot, MEMORY_DIR_NAME, 'chats', `${id}.md`) : null;
}
