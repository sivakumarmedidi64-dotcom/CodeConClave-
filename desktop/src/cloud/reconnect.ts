/**
 * CodeConClave Desktop — reconnect controller (cloud).
 *
 * Graceful network handling:
 *   - explicitly surfaced connection status (online / attempts / reconnecting)
 *   - automatic reconnect with exponential backoff (base→cap), reset on success
 *   - manual reconnect entry point (reconnect.control)
 *   - coordination with CoworkResumer so reconnects NEVER duplicate actions:
 *     the resumer compares official backend state against its last cursor and
 *     performs no action when nothing changed.
 *
 * The controller tracks only connection health; it never synthesizes a
 * "synced" claim — synchronization state comes from the backend.
 */
import type { ConnectionStatus } from '../types.js';

export interface ReconnectDeps {
  probe: () => Promise<boolean>; // true = backend reachable + session OK
  onStatus: (s: ConnectionStatus) => void;
  onReconnected?: () => Promise<void>;
}

export interface ReconnectOptions {
  baseMs?: number;
  maxMs?: number;
}

export class ReconnectController {
  private online = false;
  private attempts = 0;
  private lastError: string | null = null;
  private reconnecting = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(
    private readonly deps: ReconnectDeps,
    opts: ReconnectOptions = {},
  ) {
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 30_000;
  }

  get status(): ConnectionStatus {
    return { online: this.online, attempts: this.attempts, lastError: this.lastError, reconnecting: this.reconnecting };
  }

  /** One probe cycle (manual or scheduled). Returns the current state. */
  async tick(): Promise<ConnectionStatus> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempts += 1;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    }
    const wasOnline = this.online;
    if (!ok) {
      this.online = false;
      this.lastError = 'backend unreachable';
      this.reconnecting = true;
      this.schedule();
    } else {
      this.online = true;
      this.lastError = null;
      this.reconnecting = false;
      const recovered = !wasOnline;
      if (recovered) {
        await this.deps.onReconnected?.().catch(() => {
          /* reconcile failures are surfaced separately */
        });
      }
    }
    this.emit();
    return this.status;
  }

  /** Explicit user/UI reconnect (resets backoff on success). */
  async reconnect(): Promise<ConnectionStatus> {
    const before = this.attempts;
    const s = await this.tick();
    if (s.online) this.attempts = 0;
    this.emit();
    return { ...s, attempts: s.online ? 0 : s.attempts, reconnecting: s.online ? false : this.reconnecting, lastError: s.lastError === null && before > 0 ? null : s.lastError };
  }

  disconnect(): void {
    this.stopped = true;
    this.online = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  stop(): void {
    this.disconnect();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(this.baseMs * 2 ** Math.min(this.attempts - 1, 20), this.maxMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => undefined);
    }, delay);
  }

  private emit(): void {
    this.deps.onStatus(this.status);
  }
}