/**
 * CodeConClave Desktop — cowork resume (cloud, idempotent).
 *
 * The SAME cowork state is the live conversation in the canonical backend.
 * Resuming from Desktop (or returning to Web) never duplicates or invents
 * state: the resumer fetches the server conversation's messages via the exact
 * endpoint the web UI renders (`GET /api/v1/conversations/:id/messages`), and
 * compares a monotonic cursor per session. If the server cursor is unchanged,
 * NO further action is taken (exactly-once). Cross-tenant access is impossible
 * because the conversation endpoint is server-scoped to the session user.
 */
import type { BackendClient } from './client.js';
import { BackendError, OfflineError } from './client.js';
import type { CoworkResumeResult } from '../types.js';

export interface CoworkResumerDeps {
  client: BackendClient;
  isOnline: () => boolean;
  /** Optional idempotency tag persisted per session (foundation: memory only). */
  lastCursor: (sessionId: string) => number | null;
  setLastCursor: (sessionId: string, cursor: number) => void;
}

export interface Message { id: string; seq?: number }

export interface ResumeOptions {
  limit?: number;
}

export class CoworkResumer {
  constructor(private readonly deps: CoworkResumerDeps, private readonly opts: ResumeOptions = {}) {}

  async resume(sessionId: string): Promise<CoworkResumeResult> {
    if (!this.deps.isOnline()) {
      return { ok: false, error: 'offline', resumed: false, cursor: this.deps.lastCursor(sessionId) ?? 0, changed: false };
    }
    const limit = Math.min(this.opts.limit ?? 100, 500);
    try {
      const { data } = await this.deps.client.getJson<{ messages?: Message[] }>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
      );
      const messages = data.messages ?? [];
      // Monotonic cursor: the number of server messages is stable within the
      // read window. Compare (not set) against the last cursor.
      let cursor = 0;
      if (messages.length > 0) {
        const lastNumeric = messages.map((m) => (m.seq ?? 0)).reduce((a, b) => Math.max(a, b), 0);
        cursor = Math.max(messages.length, lastNumeric);
      }
      const prev = this.deps.lastCursor(sessionId);
      const changed = prev === null || cursor !== prev;
      this.deps.setLastCursor(sessionId, cursor);
      return { ok: true, resumed: true, cursor, changed };
    } catch (err) {
      if (err instanceof OfflineError) {
        return { ok: false, error: 'offline', resumed: false, cursor: this.deps.lastCursor(sessionId) ?? 0, changed: false };
      }
      if (err instanceof BackendError && err.status === 404) {
        return { ok: false, error: 'session_not_found', resumed: false, cursor: this.deps.lastCursor(sessionId) ?? 0, changed: false };
      }
      if (err instanceof BackendError && (err.status === 403 || err.status === 401)) {
        return { ok: false, error: 'auth_required', resumed: false, cursor: this.deps.lastCursor(sessionId) ?? 0, changed: false };
      }
      return { ok: false, error: 'resume_failed', resumed: false, cursor: this.deps.lastCursor(sessionId) ?? 0, changed: false };
    }
  }
}