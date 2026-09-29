/**
 * CodeConClave — structured logger with correlation/trace id support.
 * Never logs secrets: only structured fields explicitly passed.
 */
import { env } from '../config/env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Errors are buffered (message + correlationId only) for the diagnostics API. */
function bufferError(message: string, correlationId: string | null): void {
  try {
    const { bufferError: push } = require('../observability/error-buffer.js') as {
      bufferError: (msg: string, correlationId: string | null) => void;
    };
    push(message, correlationId);
  } catch {
    /* buffering must never break logging */
  }
}

class Logger {
  private correlationId: string | null = null;
  private readonly threshold = levelRank[env.LOG_LEVEL] ?? 20;

  withCorrelation(correlationId: string | null): Logger {
    const child = new Logger();
    child.correlationId = correlationId;
    return child;
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (levelRank[level] < this.threshold) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg: message,
      correlationId: this.correlationId ?? undefined,
      ...fields,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', message, fields);
    bufferError(message, this.correlationId);
  }
}

export const logger = new Logger();