/**
 * CodeConClave Desktop — typed event bus for main→renderer notifications.
 * Only allow-listed event names can be emitted or subscribed to.
 */
import { DESKTOP_EVENTS, type DesktopEventName } from '../types.js';

export type DesktopEventPayload =
  | { name: 'connection'; payload: import('../types.js').ConnectionStatus }
  | { name: 'workspace'; payload: import('../types.js').WorkspaceSummary[] }
  | { name: 'terminal'; payload: import('../types.js').TerminalSessionSummary[] }
  | { name: 'task'; payload: import('../types.js').TaskSummary[] }
  | { name: 'workspace-file-change'; payload: import('../types.js').FileChange };

export type AnyEvent = DesktopEventPayload & { name: DesktopEventName };

export class DesktopEventBus {
  private readonly listeners = new Map<string, Set<(msg: AnyEvent) => void>>();

  constructor() {
    for (const name of DESKTOP_EVENTS) this.listeners.set(name, new Set());
  }

  subscribe(name: DesktopEventName, cb: (msg: AnyEvent) => void): () => void {
    const set = this.listeners.get(name);
    if (!set) throw new Error(`event not allow-listed: ${name}`);
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(msg: AnyEvent): void {
    const set = this.listeners.get(msg.name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(msg);
      } catch {
        /* listener errors never break the bus */
      }
    }
  }
}