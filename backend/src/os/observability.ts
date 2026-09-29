/**
 * CodeConClave AI OS — Observability & Tracing (P1.5).
 *
 * Canonical AI OS observability. Provides structured, secret-safe spans with
 * correlation/trace/process/cowork/workspace identifiers, backed by the
 * existing structured logger and a bounded in-memory span ledger. Live-span
 * recording is a pure in-process add-on; nothing here changes the production
 * log path and no credentials are ever captured.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';

export type SpanKind =
  | 'process'
  | 'scheduler'
  | 'ipc'
  | 'resource'
  | 'sandbox'
  | 'filesystem'
  | 'git'
  | 'retry'
  | 'failure'
  | 'checkpoint'
  | 'recovery'
  | 'dag'
  | 'task'
  | 'agent';

export interface SpanContext {
  traceId: string;
  processId?: string | null;
  coworkId?: string | null;
  workspaceId?: string | null;
  parentSpanId?: string | null;
}

export interface Span {
  spanId: string;
  kind: SpanKind;
  name: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'ok' | 'error';
  errorCode?: string;
  context: SpanContext;
  fields: Record<string, unknown>;
  durationMs: number | null;
}

const MAX_SPANS = 2000;

/**
 * Trace builder. A trace is a tree of spans sharing a traceId. Each span emits
 * a structured log line tagged with the correlation identifiers, so the same
 * identifiers flow through the existing logger and diagnostics.
 */
export class Trace {
  readonly traceId: string;
  private spans: Span[] = [];
  private open: Map<string, Span> = new Map();

  constructor(seed?: { traceId?: string; workspaceId?: string | null; coworkId?: string | null }) {
    this.traceId = seed?.traceId ?? randomUUID();
    this.workspaceId = seed?.workspaceId ?? null;
    this.coworkId = seed?.coworkId ?? null;
    this.logger = logger.withCorrelation(this.traceId);
  }

  readonly workspaceId: string | null;
  readonly coworkId: string | null;
  readonly logger: typeof logger;

  begin(
    kind: SpanKind,
    name: string,
    opts: { processId?: string | null; parentSpanId?: string | null; fields?: Record<string, unknown> } = {},
  ): Span {
    const span: Span = {
      spanId: randomUUID(),
      kind,
      name,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'ok',
      context: {
        traceId: this.traceId,
        processId: opts.processId ?? null,
        coworkId: this.coworkId,
        workspaceId: this.workspaceId,
        parentSpanId: opts.parentSpanId ?? null,
      },
      fields: sanitizeFields(opts.fields ?? {}),
      durationMs: null,
    };
    this.spans.push(span);
    if (this.spans.length > MAX_SPANS) this.spans.shift();
    this.open.set(span.spanId, span);
    this.log('span.start', { kind, name, spanId: span.spanId, traceId: this.traceId });
    return span;
  }

  end(spanId: string, status: 'ok' | 'error' = 'ok', opts: { errorCode?: string; fields?: Record<string, unknown> } = {}): void {
    const span = this.open.get(spanId);
    if (!span) return;
    span.finishedAt = Date.now();
    span.status = status;
    span.errorCode = opts.errorCode;
    if (opts.fields) span.fields = { ...span.fields, ...sanitizeFields(opts.fields) };
    span.durationMs = span.finishedAt - span.startedAt;
    this.open.delete(spanId);
    this.log(`span.${status}`, {
      kind: span.kind,
      name: span.name,
      spanId: span.spanId,
      durationMs: span.durationMs,
      errorCode: opts.errorCode ?? undefined,
    });
  }

  /** Log a structured, sanitized line tied to this trace. */
  log(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.info(message, {
      traceId: this.traceId,
      workspaceId: this.workspaceId ?? undefined,
      coworkId: this.coworkId ?? undefined,
      ...sanitizeFields(fields),
    });
  }

  spansSince(): Span[] {
    return [...this.spans];
  }

  recent(kind?: SpanKind, limit = 200): Span[] {
    const all = kind ? this.spans.filter((s) => s.kind === kind) : this.spans;
    return all.slice(-limit);
  }
}

const SECRET_KEYS = /(secret|password|token|key|authorization|cookie|credential|api[-_]?key|jwt|session|private)/i;

/** Never let credentials into spans/logs. */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (typeof v === 'string' && v.length > 2048) {
      out[k] = `${v.slice(0, 2048)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}
