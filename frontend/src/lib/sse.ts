/**
 * CodeConClave — SSE chat stream reader.
 * POST /api/v1/conversations/chat streams
 * `event: <name>\ndata: <json>\n\n` frames. Events:
 * thinking_start / delta / done / limit_reached / error.
 * `limit_reached.showMoon` is server-decided (true only once per actual
 * free-limit transition) — the client never guesses.
 * Phase 16: SSE `id:` lines are parsed and the last event id is tracked so a
 * reconnecting client can ask for missed events.
 * Phase 17: `lastEventId` sends `Last-Event-ID` so the server replays the
 * assistant messages persisted after that id (missed while disconnected) as
 * `delta` frames — each carrying its own `id:` for client-side dedupe.
 */
export interface DecisionRecordedPayload {
  decisionRecorded?: { id: string; title: string; status: string } | null;
}

export type ChatStreamEvent =
  | { type: 'thinking_start'; data: Record<string, never> }
  | { type: 'delta'; data: { delta: string; id?: string | null } }
  | { type: 'done'; data: { messageId?: string | null } & DecisionRecordedPayload & Record<string, unknown> }
  | { type: 'limit_reached'; data: { showMoon: boolean } }
  | { type: 'image'; data: { fileId: string; mimeType: string } }
  | { type: 'external_agent'; data: { externalId: string; status: string; message?: string } }
  | { type: 'error'; data: { code: string; message: string; details?: unknown } };

export interface ChatRequest {
  conversationId?: string;
  projectId?: string;
  content: string;
  attachments?: { fileId: string; name: string }[];
  modelId?: string;
  mode?: 'CHAT' | 'COWORK' | 'AGENT';
  imageRequest?: boolean;
  /** Continuity: client-generated idempotency key for exactly-once retries. */
  clientId?: string;
}

export interface SseFrame {
  name: string;
  data: string;
  id: string | null;
}

/**
 * Streams a chat response. Calls onEvent for each frame; resolves with the
 * last received event id (null when the stream carried none). Aborts the
 * underlying request on cancellation.
 */
export async function streamChat(
  req: ChatRequest,
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
  lastEventId?: string,
): Promise<string | null> {
  const csrf = document.cookie.match(/(?:^|; )codeconclave_csrf=([^;]+)/)?.[1] ?? '';
  const res = await fetch('/api/v1/conversations/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': decodeURIComponent(csrf),
      Accept: 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    credentials: 'same-origin',
    // AUTO sentinel (empty string) must never reach the API as a pinned model.
    body: JSON.stringify({ ...req, modelId: req.modelId ? req.modelId : undefined }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new Error(err?.error?.message ?? `Chat failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastId: string | null = null;

  const dispatch = (frame: SseFrame) => {
    if (frame.id) lastId = frame.id;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      data = { raw: frame.data };
    }
    switch (frame.name) {
      case 'thinking_start':
        onEvent({ type: 'thinking_start', data: {} });
        break;
      case 'delta':
        onEvent({ type: 'delta', data: { delta: typeof data.delta === 'string' ? data.delta : '', id: frame.id } });
        break;
      case 'done':
        onEvent({ type: 'done', data });
        break;
      case 'limit_reached':
        onEvent({ type: 'limit_reached', data: { showMoon: data.showMoon === true } });
        break;
      case 'image':
        onEvent({
          type: 'image',
          data: { fileId: typeof data.fileId === 'string' ? data.fileId : '', mimeType: typeof data.mimeType === 'string' ? data.mimeType : '' },
        });
        break;
      case 'external_agent':
        onEvent({
          type: 'external_agent',
          data: {
            externalId: typeof data.externalId === 'string' ? data.externalId : '',
            status: typeof data.status === 'string' ? data.status : '',
            message: typeof data.message === 'string' ? data.message : undefined,
          },
        });
        break;
      case 'error':
        onEvent({
          type: 'error',
          data: {
            code: typeof data.code === 'string' ? data.code : 'internal_error',
            message: typeof data.message === 'string' ? data.message : 'Stream error',
            details: data.details,
          },
        });
        break;
      default:
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let name = '';
      let id: string | null = null;
      const payloads: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) payloads.push(line.slice(6).trim());
        else if (line.startsWith('id: ')) id = line.slice(4).trim() || null;
      }
      if (name) dispatch({ name, data: payloads.join('\n'), id });
    }
  }
  return lastId;
}

/** Pure frame parser, exported for tests. */
export function parseSseFrames(buffer: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let name = '';
    let id: string | null = null;
    const payloads: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) payloads.push(line.slice(6).trim());
      else if (line.startsWith('id: ')) id = line.slice(4).trim() || null;
    }
    if (name) frames.push({ name, data: payloads.join('\n'), id });
  }
  return frames;
}