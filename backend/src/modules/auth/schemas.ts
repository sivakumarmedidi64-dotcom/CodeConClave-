/**
 * CodeConClave — shared route helpers: unified JSON envelope.
 * Envelope: { data: {...} } — errors use { error: {code, message} } (see errorHandler).
 */
export function jsonResult<T>(data: T, meta?: Record<string, unknown>): { data: T; meta?: Record<string, unknown> } {
  const result: { data: T; meta?: Record<string, unknown> } = { data };
  if (meta) result.meta = meta;
  return result;
}