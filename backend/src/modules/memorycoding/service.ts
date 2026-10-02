/**
 * CodeConClave — PKG-23 Memory-Powered Coding — capabilities & honest status.
 *
 * The capability report tells the truth about what memory-coding can and cannot
 * do in the current environment:
 *   - PERSISTENT_MEMORY: the existing memory system (reused, not rebuilt).
 *   - MEMORY_RETRIEVAL: DETERMINISTIC or HEURISTIC — we never claim semantic-AI
 *     retrieval unless real embeddings produced it.
 *   - FEATURE_GATE: whether the AIOS_P2_MEMORY_CODING flag is ON.
 *   - bounds: the bounded retrieval/context/inspector limits.
 */
import { MCP_CONFIG } from './config.js';

export interface MemoryCodingCapabilities {
  persistentMemory: boolean;
  memoryRetrieval: 'DETERMINISTIC' | 'HEURISTIC';
  featureGateEnabled: boolean;
  featureGateKey: string;
  usesReusedMemorySystem: boolean;
  bounds: {
    maxRelevanceResults: number;
    maxCodingContextMemories: number;
    maxAgentContextItems: number;
    maxEditorContextItems: number;
    maxInspectorPageSize: number;
  };
  notes: string[];
}

export function memoryCodingCapabilities(): MemoryCodingCapabilities {
  const featureGateEnabled = MCP_CONFIG.enabled();
  const notes: string[] = [];
  if (!featureGateEnabled) notes.push('Feature-gated OFF: memory-coding endpoints report UNAVAILABLE and never mutate.');
  notes.push('MEMORY_RETRIEVAL is DETERMINISTIC/HEURISTIC (signal-scored), not a semantic-AI claim.');
  notes.push('Memory is advisory and never overrides the current repository.');
  return {
    persistentMemory: true,
    memoryRetrieval: 'DETERMINISTIC',
    featureGateEnabled,
    featureGateKey: 'AIOS_P2_MEMORY_CODING',
    usesReusedMemorySystem: true,
    bounds: {
      maxRelevanceResults: MCP_CONFIG.maxRelevanceResults,
      maxCodingContextMemories: MCP_CONFIG.maxCodingContextMemories,
      maxAgentContextItems: MCP_CONFIG.maxAgentContextItems,
      maxEditorContextItems: MCP_CONFIG.maxEditorContextItems,
      maxInspectorPageSize: MCP_CONFIG.maxInspectorPageSize,
    },
    notes,
  };
}
