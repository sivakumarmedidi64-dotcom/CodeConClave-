/**
 * CodeConClave — Quality Intelligence Types (PKG-14).
 * Canonical types for static code-quality and correctness analysis (Code Smell
 * Agent, Concurrent Bug Detector, Memory Leak Hunter, Type Safety Enhancer,
 * Invariant Keeper). Every finding carries an explicit truthfulness state and
 * confidence so callers never mistake a heuristic for a proven bug.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / capability status / truthfulness
// ---------------------------------------------------------------------------

export const AnalysisKind = z.enum([
  'CODE_SMELL',      // #6
  'CONCURRENCY',     // #7
  'MEMORY_LEAK',     // #8
  'TYPE_SAFETY',     // #9
  'INVARIANT',       // #10
]);
export type AnalysisKind = z.infer<typeof AnalysisKind>;

export const CapabilityStatus = z.enum([
  'AVAILABLE',
  'UNAVAILABLE',
  'ENVIRONMENT_BLOCKED',
  'NOT_IMPLEMENTED',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

/** Truthfulness state attached to every finding. */
export const TruthfulnessState = z.enum([
  'VERIFIED',      // hard deterministic match
  'HEURISTIC',     // pattern-based, confidence < 1.0
  'PROVIDER_REQUIRED',
  'ENVIRONMENT_BLOCKED',
  'UNAVAILABLE',
]);
export type TruthfulnessState = z.infer<typeof TruthfulnessState>;

export const FindingSeverity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

// ---------------------------------------------------------------------------
// Requests (Zod schemas for runtime validation)
// ---------------------------------------------------------------------------

export const AnalyzeProjectRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  kinds: z.array(AnalysisKind).min(1).max(5).optional(),
  fileIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  maxFindingsPerKind: z.number().int().min(1).max(500).optional().default(200),
});
export type AnalyzeProjectRequest = z.infer<typeof AnalyzeProjectRequestSchema>;

export const AnalyzeFileRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  fileId: z.string().min(1).max(200),
});
export type AnalyzeFileRequest = z.infer<typeof AnalyzeFileRequestSchema>;

export const CapabilitiesRequestSchema = z.object({}).optional();

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A single advisory finding from one analyzer. */
export interface QualityFinding {
  id: string;
  kind: AnalysisKind;
  filePath: string;
  fileId: string;
  line: number | null;
  rule: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  confidence: number; // 0..1
  state: TruthfulnessState;
  evidence: string;
  suggestion: string;
}

export interface AnalyzedFile {
  fileId: string;
  path: string;
  bytes: number;
  analyzed: boolean;
  reason?: string;
}

export interface QualityAnalysisResult {
  id: string;
  projectId: string;
  kinds: AnalysisKind[];
  files: AnalyzedFile[];
  findings: QualityFinding[];
  totals: {
    VERIFIED: number;
    HEURISTIC: number;
    UNAVAILABLE: number;
    ENVIRONMENT_BLOCKED: number;
    NOT_IMPLEMENTED: number;
    [key: string]: number;
  };
  byKind: Record<AnalysisKind, { findings: number; bySeverity: Record<FindingSeverity, number>; byState: Record<TruthfulnessState, number> }>;
  correlationId: string;
  generatedAt: Date;
}

/** Honest capability report for the five analyzers. */
export interface QualityCapabilityReport {
  capabilities: Record<
    AnalysisKind,
    {
      status: CapabilityStatus;
      state: TruthfulnessState;
      deterministic: boolean;
      needsProvider: boolean;
      description: string;
    }
  >;
  limitations: string[];
}
