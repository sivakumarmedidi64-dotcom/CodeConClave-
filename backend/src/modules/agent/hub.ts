/**
 * CodeConClave — Local Agent hub singleton.
 *
 * Holds the process-wide AgentHub instance so the dispatcher (dispatch.ts) can
 * send task frames without a runtime import cycle: ws.ts imports dispatch.ts
 * for its message handlers, while dispatch.ts reaches the hub through this
 * dep-free module. The type import below is erased at build time.
 */
import type { AgentHub } from './ws.js';

let instance: AgentHub | null = null;

export function setHub(hub: AgentHub): void {
  instance = hub;
}

export function wsHub(): AgentHub {
  if (!instance) throw new Error('agent hub not attached');
  return instance;
}
