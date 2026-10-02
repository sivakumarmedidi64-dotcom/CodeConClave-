/**
 * Shared outbound HTTP guardrails (Stage 25 hardening).
 * Every external network call outside the AI gateway must carry a hard
 * deadline: no bare fetch may wait forever (socket hang → request stalls).
 * The AI gateway has its own layered timeouts (AI_REQUEST_TIMEOUT_MS /
 * AI_CHAIN_TIMEOUT_MS); everything else uses this bound.
 */
export const OUTBOUND_TIMEOUT_MS = 15_000;

export function outboundSignal(ms: number = OUTBOUND_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}