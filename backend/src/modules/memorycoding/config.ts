/**
 * CodeConClave — PKG-23 Memory-Powered Coding — configuration.
 * Feature-gated (honest, reversible): memory-coding routes report
 * UNAVAILABLE/ENVIRONMENT_BLOCKED and never mutate when the flag is OFF.
 * Bounded retrieval/context limits keep the editor and agents fast by default.
 */
import { env } from '../../config/env.js';

export const MCP_CONFIG = {
  /** Feature flag. Default OFF; reversible. */
  enabled(): boolean {
    return env.AIOS_P2_MEMORY_CODING === 'true';
  },
  /** Bounded relevance results. */
  maxRelevanceResults: 20,
  /** Bounded coding-context memory items. */
  maxCodingContextMemories: 8,
  maxCodingContextEvidence: 6,
  maxCodingContextDecisions: 4,
  maxCodingContextPatterns: 4,
  /** Bounded agent-planning context. */
  maxAgentContextItems: 10,
  /** Bounded editor-context items. */
  maxEditorContextItems: 12,
  /** Bounded inspector list page size. */
  maxInspectorPageSize: 100,
  /** Lifecycle: never auto-archives active valuable memory; honors soft-delete. */
  maxPatternEvidenceForHighConfidence: 5,
  maxPatternEvidenceForConfident: 2,
  maxBugIncidentsPerUser: 500,
} as const;

/** Maximum bytes of captured content that may be persisted (pre-redaction). */
export const MCP_MAX_CAPTURE_BYTES = 8000;
