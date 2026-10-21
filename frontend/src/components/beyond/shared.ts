/** Small helpers shared by the Beyond panels. */
import { ApiError, csrfToken } from '../../lib/api';
import { reportLimitError } from '../UsageLimitDialog';

/** A readable error message; plan/usage limits also open the Limit Guard pop-up. */
export function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) reportLimitError(err.code, err.message, err.details);
  return err instanceof Error && err.message ? err.message : fallback;
}

/** POST a raw .ccteleport bundle (the JSON api() helper cannot send bytes). */
export async function postBundle<T>(path: string, bytes: ArrayBuffer): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken() },
    body: bytes,
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }
  return (body?.data ?? body) as T;
}

/** Same severity order everywhere (most serious first). */
export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

/** What a Council finding pre-fills in the Immunity form. */
export interface VaccineDraft {
  name: string;
  pattern: string;
  kind: 'literal' | 'regex';
  fixNote: string;
  severity: Severity;
}
