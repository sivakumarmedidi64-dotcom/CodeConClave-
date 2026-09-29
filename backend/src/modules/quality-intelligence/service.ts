/**
 * CodeConClave — Quality Intelligence Service (PKG-14).
 * Orchestrates deterministic, server-authoritative static analysis across the
 * five Group C code-quality capabilities. Findings are advisory; no code is
 * changed, no bug is "proven", and no capability is overstated.
 */
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { loadSourceFile, listSourceFiles } from './security.js';
import {
  ANALYZERS,
  ALL_KINDS,
  KIND_DESCRIPTIONS,
} from './analyzers.js';
import type { AnalyzerInput } from './analyzers.js';
import type {
  AnalysisKind,
  QualityAnalysisResult,
  QualityCapabilityReport,
  QualityFinding,
  AnalyzeProjectRequest,
  AnalyzeFileRequest,
  CapabilityStatus,
  FindingSeverity,
  TruthfulnessState,
  AnalyzedFile,
} from './types.js';

function emptySeverityMap(): Record<FindingSeverity, number> {
  return { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
}
function emptyStateMap(): Record<TruthfulnessState, number> {
  return { VERIFIED: 0, HEURISTIC: 0, PROVIDER_REQUIRED: 0, ENVIRONMENT_BLOCKED: 0, UNAVAILABLE: 0 };
}
function emptyTotals(): QualityAnalysisResult['totals'] {
  return { VERIFIED: 0, HEURISTIC: 0, UNAVAILABLE: 0, ENVIRONMENT_BLOCKED: 0, NOT_IMPLEMENTED: 0 };
}

function correlationId(): string {
  return newId('qlt');
}

export class QualityIntelligenceService {
  /**
   * Analyze a single file by id (isolated via files service) for the requested
   * kinds. If no kinds provided, all five run.
   */
  async analyzeFile(userId: string, request: AnalyzeFileRequest): Promise<QualityAnalysisResult> {
    const src = await loadSourceFile(userId, request.projectId, request.fileId);
    const kinds = [...ALL_KINDS];
    return this.runAnalysis(userId, request.projectId, [src], kinds, 100);
  }

  /**
   * Analyze a project's analyzable source files for the requested kinds.
   * Honest per-file reporting of skipped/non-text files.
   */
  async analyzeProject(userId: string, request: AnalyzeProjectRequest): Promise<QualityAnalysisResult> {
    const { analyzable, skipped } = await listSourceFiles(userId, request.projectId, request.fileIds);
    const kinds = (request.kinds?.length ? request.kinds : [...ALL_KINDS]) as AnalysisKind[];
    const maxPerKind = request.maxFindingsPerKind ?? 200;

    const files: AnalyzedFile[] = analyzable.map((f) => ({
      fileId: f.fileId,
      path: f.path,
      bytes: f.bytes,
      analyzed: true,
    }));
    for (const s of skipped) {
      files.push({ fileId: s.fileId, path: s.path, bytes: 0, analyzed: false, reason: s.reason });
    }

    const result = this.runAnalysis(userId, request.projectId, analyzable, kinds, maxPerKind);
    result.files = files;
    return result;
  }

  private runAnalysis(
    userId: string,
    projectId: string,
    sources: AnalyzerInput[],
    kinds: AnalysisKind[],
    maxPerKind: number,
  ): QualityAnalysisResult {
    void userId;
    const findings: QualityFinding[] = [];
    const byKind = {} as QualityAnalysisResult['byKind'];
    for (const k of kinds) {
      byKind[k] = { findings: 0, bySeverity: emptySeverityMap(), byState: emptyStateMap() };
    }

    const totals = emptyTotals();
    let seq = 0;

    for (const src of sources) {
      for (const kind of kinds) {
        const analyzer = ANALYZERS[kind];
        if (!analyzer) continue;
        const found = analyzer(src, Math.max(1, maxPerKind), seq);
        for (const f of found) {
          findings.push(f);
          seq++;
          if (byKind[kind]) {
            byKind[kind].findings++;
            byKind[kind].bySeverity[f.severity]++;
            byKind[kind].byState[f.state]++;
          }
          totals[f.state] = (totals[f.state] ?? 0) + 1;
        }
      }
    }

    const result: QualityAnalysisResult = {
      id: correlationId(),
      projectId,
      kinds,
      files: sources.map((s) => ({ fileId: s.fileId, path: s.path, bytes: s.text.length, analyzed: true })),
      findings,
      totals,
      byKind,
      correlationId: correlationId(),
      generatedAt: new Date(),
    };
    return result;
  }

  /** Honest capability report for the five analyzers (all deterministic). */
  getCapabilities(): QualityCapabilityReport {
    const status: CapabilityStatus = 'AVAILABLE';
    const capabilities = {} as QualityCapabilityReport['capabilities'];
    for (const k of ALL_KINDS) {
      capabilities[k] = {
        status,
        state: 'HEURISTIC',
        deterministic: true,
        needsProvider: false,
        description: KIND_DESCRIPTIONS[k],
      };
    }
    return {
      capabilities,
      limitations: [
        'Static, source-text heuristics only. Findings are advisory, not proof.',
        'No compilation, type-checking, execution, or runtime tracing.',
        'Line/column references are best-effort line numbers.',
        'Binary and oversized files are skipped, never analyzed.',
      ],
    };
  }

  /** Validate a requested kind string; throws for unknown kinds. */
  assertKind(kind: string): AnalysisKind {
    if (!(ALL_KINDS as string[]).includes(kind)) {
      throw AppError.badRequest('quality_unknown_kind', `Unknown analysis kind: ${kind}`);
    }
    return kind as AnalysisKind;
  }
}

export const qualityIntelligenceService = new QualityIntelligenceService();
