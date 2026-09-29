/**
 * CodeConClave — PKG-24 AI Developer Copilot — configuration.
 * Feature-gated (honest, reversible): the copilot reports UNAVAILABLE and never
 * mutates the repository when the flag is OFF. Bounded context/output/resource
 * limits keep the editor and agents fast by default — no "unlimited AI" claims.
 */
import { env } from '../../config/env.js';

export const COPILOT_CONFIG = {
  /** Feature flag. Default OFF; reversible. */
  enabled(): boolean {
    return env.AIOS_P2_COPILOT === 'true';
  },
  /** Bounded context bytes fed to a model per request (64 KiB, matching workspace). */
  maxContextBytes: 64 * 1024,
  /** Maximum generated content bytes returned to the client. */
  maxOutputBytes: 32 * 1024,
  /** Maximum number of evidence items / memory items / results in a response. */
  maxMemoryItems: 10,
  maxEvidenceItems: 12,
  maxRelatedFiles: 8,
  maxAlternatives: 3,
  /** Test-generation proposal cap per request. */
  maxTestProposals: 12,
  /** Diagnosis bound. */
  maxDiagnosisClues: 10,
  /** Look-back for runtime/deployment evidence. */
  recentEvidenceDays: 14,
  /** Caching TTL for expensive, idempotent retrieval. */
  cacheTtlMs: 15_000,
  /** Bounded ask-history citations returned. */
  maxAskEvidence: 10,
  /** LLM compute class for copilot workloads (B = balanced). */
  computeClass: 'B' as 'A' | 'B' | 'C',
} as const;

/** Maximum bytes of captured file content used to build a copilot prompt. */
export const COPILOT_MAX_CAPTURE_BYTES = 32 * 1024;
