/**
 * CodeConClave — in-process buffer of recent critical errors (Phase 15).
 * Keeps the last N error records (message + traceId only — never stack traces,
 * request bodies, or secret values) for the operator diagnostics API.
 */
const MAX_ENTRIES = 50;

export interface BufferedError {
  t: string;
  msg: string;
  traceId: string | null;
}

const entries: BufferedError[] = [];

export function bufferError(msg: string, traceId: string | null): void {
  entries.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 1000), traceId });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function recentErrors(): BufferedError[] {
  return [...entries];
}

/** Test hook only. */
export function clearErrorBuffer(): void {
  entries.length = 0;
}