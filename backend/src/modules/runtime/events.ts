/**
 * CodeConClave — PKG-19 runtime — realtime event hub (F49 anchor).
 * In-memory SSE pub/sub keyed by project for execution, background-task,
 * verification and capture updates. Subscribers reconnect on reload
 * (the stream is a live notification channel, not durable storage).
 */
export type RuntimeEvent =
  | { type: 'execution'; id: string; projectId: string; status: string; ts: string }
  | { type: 'background'; id: string; projectId: string; status: string; ts: string }
  | { type: 'verification'; id: string; projectId: string; status: string; ts: string }
  | { type: 'capture'; projectId: string; channel: 'console' | 'network'; ts: string }
  | { type: 'preview'; projectId: string; state: string; ts: string }
  | { type: 'task'; id: string; projectId: string; status: string; ts: string }
  | { type: 'coworker'; id: string; runId: string; projectId: string; state: string; ts: string };

const subscribers = new Map<string, Set<(event: RuntimeEvent) => void>>();

/** Subscribe to runtime events for a project. Returns an unsubscribe fn. */
export function subscribeRuntime(
  projectId: string,
  cb: (event: RuntimeEvent) => void,
): () => void {
  let set = subscribers.get(projectId);
  if (!set) {
    set = new Set();
    subscribers.set(projectId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set?.size === 0) subscribers.delete(projectId);
  };
}

/** Broadcast a runtime event to a project's subscribers. Never throws. */
export function broadcastRuntime(projectId: string, event: RuntimeEvent): void {
  const set = subscribers.get(projectId);
  if (!set || set.size === 0) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch {
      /* subscriber errors never break the stream */
    }
  }
}

/** Emit a preview-state event (bridged from the F38 preview service). */
export function emitPreviewRuntime(projectId: string, state: string): void {
  broadcastRuntime(projectId, { type: 'preview', projectId, state, ts: new Date().toISOString() });
}
