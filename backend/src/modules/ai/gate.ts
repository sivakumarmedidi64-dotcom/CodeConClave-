/**
 * CodeConClave — Stage 81 AI PROVIDER GATE ("keep only the ones that work").
 *
 * Provider quality gate: providers that provably cannot work in this
 * environment are HIDDEN and DISABLED across the whole app (status snapshot,
 * configured-provider routing, adapter construction) WITHOUT deleting their
 * code. A gated provider:
 *
 *   - is never "configured" (key presence is irrelevant — the gate wins),
 *   - is never selectable by the model router / gateway,
 *   - cannot produce an adapter (fail closed even if a key exists),
 *   - still appears in the status snapshot as BLOCKED with the real reason, so
 *     the founder sees exactly why it is out of action.
 *
 * This is configuration, not data: the registry rows already DISABLE these
 * model rows; the gate extends the same discipline to the service layer.
 */
export const PROVIDER_QUALITY_GATE: Record<string, string> = {
  manus: 'ENVIRONMENT_BLOCKED - external agent, no safe read-only probe exists and the gate rule forbids task-creating calls',
  big_pickle: 'ENVIRONMENT_BLOCKED - provider not reachable from this environment',
};

/** Reason a provider is gated, or null when it may operate normally. */
export function providerGateReason(providerId: string): string | null {
  return PROVIDER_QUALITY_GATE[providerId] ?? null;
}

/** A provider may be shown/used only when it is not behind the quality gate. */
export function isProviderVisible(providerId: string): boolean {
  return providerGateReason(providerId) === null;
}