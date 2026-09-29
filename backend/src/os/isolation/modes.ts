/**
 * CodeConClave AI OS — isolation modes (real-isolation layer).
 *
 * Honest, ordered classification of execution boundaries. `POLICY_ONLY` is the
 * policy sandbox (deny-by-default) and is deliberately ranked BELOW real OS
 * isolation: policy isolation is NEVER presented as container/process
 * isolation. Callers that require real isolation must declare a minMode; the
 * facade FAILS CLOSED when the host cannot satisfy it.
 */

export const IsolationMode = {
  NONE: 'none',
  POLICY_ONLY: 'policy_only',
  PROCESS: 'process',
  CONTAINER: 'container',
  MICROVM: 'microvm',
} as const;
export type IsolationMode = (typeof IsolationMode)[keyof typeof IsolationMode];

const RANK: Record<IsolationMode, number> = {
  none: 0,
  policy_only: 1,
  process: 2,
  container: 3,
  microvm: 4,
};

/** Ordering check: does `actual` meet or exceed `required` isolation? */
export function satisfies(actual: IsolationMode, required: IsolationMode): boolean {
  return RANK[actual] >= RANK[required];
}

/** True when `mode` is an actual OS-level boundary (not policy-only). */
export function isRealIsolation(mode: IsolationMode): boolean {
  return mode === 'process' || mode === 'container' || mode === 'microvm';
}

export function isIsolationMode(v: string): v is IsolationMode {
  return Object.values(IsolationMode).includes(v as IsolationMode);
}