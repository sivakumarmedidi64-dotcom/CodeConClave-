/**
 * CodeConClave — automation templates + conditions (Stage 26D).
 * Recipes and rule actions may reference event data via {{path}} placeholders.
 * Paths are strictly allowlisted (payload.*, event.eventId, event.eventType,
 * event.source, now.iso) — interpolation can never read secrets or
 * out-of-band state. Conditions are evaluated deterministically against the
 * event payload.
 */
import { AppError } from '../../shared/errors.js';

export interface TemplateContext {
  payload: Record<string, unknown>;
  event: { eventId: string; eventType: string; source: string };
}

export function getPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Resolve a single {{path}} placeholder. Returns null when the path is unknown. */
export function resolvePlaceholder(raw: string, ctx: TemplateContext): string | null {
  const m = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/.exec(raw.trim());
  if (!m) return null;
  const path = m[1]!;
  if (path === 'now.iso') return new Date().toISOString();
  if (path === 'event.eventId') return ctx.event.eventId;
  if (path === 'event.eventType') return ctx.event.eventType;
  if (path === 'event.source') return ctx.event.source;
  if (path.startsWith('payload.')) {
    const value = getPath(ctx.payload, path.slice('payload.'.length));
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return null;
}

/** Interpolate a template string containing {{path}} placeholders. */
export function interpolate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/g, (whole) => {
    return resolvePlaceholder(whole, ctx) ?? '';
  });
}

/** Recursively interpolate strings inside a JSON-ish value (rules/actions). */
export function renderValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderValue(v, ctx);
    return out;
  }
  return value;
}

/** Validate that every placeholder in a value resolves to an allowed path. */
export function validatePlaceholders(value: unknown): void {
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v)) !== null) {
        const path = m[1]!;
        const ok = path === 'now.iso' || path.startsWith('event.') || path.startsWith('payload.');
        if (!ok) throw AppError.badRequest('invalid_placeholder', `Unsupported template path {{${path}}}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
}

/** Evaluate a conditions map against a payload. Every key must pass. */
export function evaluateConditions(
  conditions: Record<string, unknown>,
  payload: Record<string, unknown>,
): { matched: boolean; reason?: string } {
  const entries = Object.entries(conditions ?? {});
  if (entries.length === 0) return { matched: true };
  for (const [path, expected] of entries) {
    const actual = getPath(payload, path.startsWith('payload.') ? path.slice('payload.'.length) : path);
    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      const op = (expected as Record<string, unknown>).op as string | undefined;
      const value = (expected as Record<string, unknown>).value;
      switch (op) {
        case 'eq':
          if (actual !== value) return { matched: false, reason: `${path} !== ${String(value)}` };
          break;
        case 'ne':
          if (actual === value) return { matched: false, reason: `${path} === ${String(value)}` };
          break;
        case 'exists':
          if (actual === undefined) return { matched: false, reason: `${path} missing` };
          break;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          const a = Number(actual);
          if (!Number.isFinite(a)) return { matched: false, reason: `${path} not numeric` };
          const b = Number(value);
          const pass = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
          if (!pass) return { matched: false, reason: `${path} failed ${op}` };
          break;
        }
        case 'in': {
          const list = Array.isArray(value) ? value.map(String) : [];
          if (!list.includes(String(actual))) return { matched: false, reason: `${path} not in list` };
          break;
        }
        case 'contains':
          if (typeof actual !== 'string' || !actual.includes(String(value))) {
            return { matched: false, reason: `${path} does not contain value` };
          }
          break;
        default:
          throw AppError.badRequest('invalid_condition', `Unsupported condition op ${String(op)}`);
      }
    } else if (actual !== expected) {
      return { matched: false, reason: `${path} !== ${String(expected)}` };
    }
  }
  return { matched: true };
}