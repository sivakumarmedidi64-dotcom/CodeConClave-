/**
 * CodeConClave — Visual Intelligence Service (PKG-13).
 * Orchestrates image/screenshot/UI analysis, diagram + architecture + state
 * machine visualization (reusing existing subsystems), advisory code proposals,
 * honest capability reporting, and secure result caching. Every result is
 * capability-honest; nothing is fabricated.
 */
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { generateDiagram } from '../developer-productivity/flowDiagram.js';
import {
  getArchitectureSummary,
  getDependencyGraph,
  detectArchitectureRisks,
} from '../engineering-intelligence/architectureOracle.js';
import type { DiagramType, DiagramOptions } from '../developer-productivity/flowDiagram.js';
import { visualIntelligenceCache } from './cache.js';
import { loadValidatedImage, detectVisualPromptInjection, imageHasExecutableSignature } from './security.js';
import {
  extractImageMetadata,
  heuristicUIAnalysis,
  buildCodeProposal,
  parseDiagramToStructure,
  diagramToCode,
  validateDiagramContent,
  getPixelComparisonCapability,
  getProviderCapabilities,
} from './analyzers.js';
import type {
  VisualAnalysisRequest,
  VisualAnalysisResult,
  UIAnalysisResult,
  ImageMetadata,
  VisualFinding,
  CodeProposal,
  DiagramToCodeRequest,
  ProviderCapabilityReport,
  VisualRegressionResult,
  VisualCapabilityStatus,
} from './types.js';

function correlationId(): string {
  return newId('vis');
}

export class VisualIntelligenceService {
  /**
   * Main analysis entry point. Delegates to the appropriate analyzer and caches
   * the result keyed by user+workspace. When no real vision provider exists, an
   * honest HEURISTIC/UNAVAILABLE result is returned — never fabricated vision.
   */
  async analyzeImage(userId: string, request: VisualAnalysisRequest): Promise<VisualAnalysisResult> {
    const image = await loadValidatedImage(userId, request.projectId, request.imageFileId);

    // Prompt-injection containment on any embedded text-like payload (SVG).
    const textProbe = image.buffer.toString('utf8', 0, Math.min(4096, image.buffer.length));
    const injection = detectVisualPromptInjection(textProbe);
    if (injection.detected) {
      throw AppError.badRequest('prompt_injection_detected', 'Image content contains a disallowed instruction payload');
    }
    if (imageHasExecutableSignature(image.buffer)) {
      throw AppError.badRequest('image_executable', 'Image content has an executable signature');
    }

    const type = request.analysisType ?? 'SCREENSHOT';
    const cacheKey = this.cacheKey(type, request.imageFileId, image);
    const cached = await visualIntelligenceCache.get<VisualAnalysisResult>(cacheKey, userId, request.projectId);
    if (cached) return cached.value;

    const result = await this.runAnalysis(userId, type, request.projectId, image);

    await visualIntelligenceCache.set(cacheKey, result, userId, request.projectId);
    return result;
  }

  private cacheKey(type: string, fileId: string, image: { buffer: Buffer }): string {
    let hash = 0;
    const len = Math.min(image.buffer.length, 1024);
    for (let i = 0; i < len; i++) {
      hash = (hash * 31 + (image.buffer[i] ?? 0)) | 0;
    }
    return `${type}:${fileId}:${hash.toString(16)}`;
  }

  private async runAnalysis(
    userId: string,
    type: string,
    projectId: string,
    image: { buffer: Buffer; mimeType: string; metadata: { format: string; width: number | null; height: number | null; colorSpace: string; hasAlpha: boolean } },
  ): Promise<VisualAnalysisResult> {
    const base = heuristicUIAnalysis(image);

    switch (type) {
      case 'METADATA': {
        const metadata = extractImageMetadata(image);
        return {
          id: correlationId(),
          type: 'METADATA',
          state: 'VERIFIED',
          metadata,
          findings: [
            {
              id: newId('vfd'),
              type: 'METADATA',
              severity: 'LOW',
              title: 'Image metadata',
              description: 'Deterministic metadata extracted from the image header.',
              confidence: 1,
              evidence: `${metadata.width}x${metadata.height} ${metadata.format} ${metadata.colorSpace}`,
            },
          ],
          confidence: 1,
          provider: 'local-header-parser',
          limitations: ['Header-derived only; no pixel or semantic understanding.'],
          correlationId: correlationId(),
          generatedAt: new Date(),
        };
      }
      case 'SCREENSHOT':
        // Honest: screenshot SEMANTIC understanding requires a real vision model.
        return {
          ...(base as Omit<VisualAnalysisResult, 'correlationId' | 'generatedAt' | 'id'>),
          id: correlationId(),
          type: 'SCREENSHOT',
          state: 'ENVIRONMENT_BLOCKED',
          provider: 'env-blocked',
          confidence: 0,
          limitations: [
            'No screenshot caption source on this server (privacy stub returns unavailable).',
            'No real vision provider is configured: screenshot CONTENT is not understood.',
            'Only header metadata and layout heuristics are available.',
          ],
          findings: [],
          correlationId: correlationId(),
          generatedAt: new Date(),
        };
      case 'DIAGRAM':
      case 'ARCHITECTURE':
      case 'STATE_MACHINE':
        // These analyze project structure, not the image; pass through with a clear label.
        return {
          ...(base as Omit<VisualAnalysisResult, 'correlationId' | 'generatedAt' | 'id'>),
          id: correlationId(),
          type: type as VisualAnalysisResult['type'],
          state: 'HEURISTIC',
          findings: [],
          correlationId: correlationId(),
          generatedAt: new Date(),
        };
      case 'UI':
      default: {
        const ui = base as UIAnalysisResult;
        ui.id = correlationId();
        ui.correlationId = correlationId();
        ui.generatedAt = new Date();
        ui.type = 'UI';
        return ui;
      }
    }
  }

  /** Analyze a screenshot-image, honest about semantic capabilities. */
  async analyzeScreenshot(userId: string, request: VisualAnalysisRequest): Promise<VisualAnalysisResult> {
    return this.analyzeImage(userId, { ...request, analysisType: 'SCREENSHOT' });
  }

  /** Analyze a UI image with honest heuristic metadata only. */
  async analyzeUI(userId: string, request: VisualAnalysisRequest): Promise<UIAnalysisResult> {
    const res = await this.analyzeImage(userId, { ...request, analysisType: 'UI' });
    return res as UIAnalysisResult;
  }

  /** Advisory code proposal for an analyzed image (B1 review required). */
  async generateCodeProposal(userId: string, request: {
    imageFileId: string;
    projectId: string;
    analysisType?: VisualAnalysisRequest['analysisType'];
    targetLanguage?: string;
  }): Promise<CodeProposal> {
    const analysis = await this.analyzeImage(userId, {
      imageFileId: request.imageFileId,
      projectId: request.projectId,
      analysisType: request.analysisType ?? 'UI',
    });
    return buildCodeProposal(analysis, request.targetLanguage ?? 'typescript');
  }

  /** Generate a Mermaid diagram, reusing flowDiagram.ts. */
  async generateDiagram(userId: string, opts: DiagramOptions): Promise<{ id: string; type: DiagramType; projectId: string; mermaid: string; metadata: unknown; generatedAt: Date }> {
    return generateDiagram(userId, opts);
  }

  /** Parse diagram text → advisory code scaffold (B1 required). */
  async generateDiagramCode(userId: string, request: DiagramToCodeRequest): Promise<CodeProposal> {
    validateDiagramContent(request.content, request.diagramType);
    const model = parseDiagramToStructure(request.diagramType, request.content);
    if (model.nodes.length === 0) {
      throw AppError.badRequest('diagram_unparseable', 'No nodes could be parsed from the diagram');
    }
    return diagramToCode(model, request.targetLanguage);
  }

  /** Architecture visualization, reusing architectureOracle.ts. */
  async getArchitectureVisualization(userId: string, projectId: string): Promise<unknown> {
    const [summary, graph, risks] = await Promise.all([
      getArchitectureSummary(userId, projectId),
      getDependencyGraph(userId, projectId),
      detectArchitectureRisks(userId, projectId),
    ]);
    return { summary, graph, risks, correlationId: correlationId() };
  }

  /** State-machine visualization, reusing flowDiagram.ts state type. */
  async getStateMachineVisualization(userId: string, projectId: string, scope?: string): Promise<unknown> {
    return generateDiagram(userId, {
      type: 'state',
      projectId,
      scope,
      includeLegend: true,
    } as DiagramOptions);
  }

  /** Visual regression — honest: pixel comparison is not implemented. */
  async getVisualRegression(userId: string, before: VisualAnalysisResult | null, after: VisualAnalysisResult | null): Promise<VisualRegressionResult> {
    const pixelStatus = getPixelComparisonCapability();
    const result: VisualRegressionResult = {
      available: before !== null && after !== null,
      before: before?.metadata ?? null,
      after: after?.metadata ?? null,
      diff: null,
      changes: this.metadataDiff(before?.metadata ?? null, after?.metadata ?? null),
      state: 'UNAVAILABLE',
      pixelComparison: pixelStatus === 'AVAILABLE',
      limitations: [
        pixelStatus === 'NOT_IMPLEMENTED'
          ? 'Pixel-level comparison is not implemented (no image-processing library).'
          : 'Pixel comparison is environment-blocked.',
        'Only metadata-level differences between the two images are reported.',
      ],
      correlationId: correlationId(),
    };
    void userId;
    return result;
  }

  /** Report metadata-level differences between two images (NOT pixel diff). */
  private metadataDiff(before: ImageMetadata | null, after: ImageMetadata | null): string[] {
    if (!before || !after) return [];
    const changes: string[] = [];
    if (before.width !== after.width || before.height !== after.height) {
      changes.push(`dimensions: ${before.width}x${before.height} -> ${after.width}x${after.height}`);
    }
    if (before.format !== after.format) changes.push(`format: ${before.format} -> ${after.format}`);
    if (before.fileSizeBytes !== after.fileSizeBytes) {
      changes.push(`size: ${before.fileSizeBytes} -> ${after.fileSizeBytes} bytes`);
    }
    return changes;
  }

  /** Honest provider capability report. */
  async getProviderCapabilities(userId: string): Promise<ProviderCapabilityReport> {
    return getProviderCapabilities(userId);
  }

  /** Cache invalidation by predefined scope. */
  async clearCache(pattern: string): Promise<{ cleared: number }> {
    const count = await visualIntelligenceCache.invalidatePattern(pattern);
    return { cleared: count };
  }

  getCacheStats() {
    return visualIntelligenceCache.getStats();
  }

  /** Capability enum accessor for internal use/tests. */
  static readonly capabilities: Record<string, VisualCapabilityStatus> = {
    vision: 'ENVIRONMENT_BLOCKED',
    ocr: 'UNAVAILABLE',
    multimodal: 'ENVIRONMENT_BLOCKED',
    pixelComparison: 'NOT_IMPLEMENTED',
  };
}

export const visualIntelligenceService = new VisualIntelligenceService();
