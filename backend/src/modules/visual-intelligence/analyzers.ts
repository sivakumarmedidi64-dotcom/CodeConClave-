/**
 * CodeConClave — Visual Intelligence Analyzers (PKG-13).
 * Deterministic, evidence-based analysis primitives. These never fabricate real
 * vision: they parse image headers for metadata, derive honest heuristics from
 * dimensions/aspect-ratio, detect provider capabilities by consulting the real
 * environment (AI Gateway, configured providers), and convert diagram text into
 * structured models for advisory code proposals.
 */
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { eligibleModels } from '../ai/gateway.js';
import type {
  ImageMetadata,
  UIComponent,
  UITextRegion,
  VisualAnalysisResult,
  VisualFinding,
  UIAnalysisResult,
  CodeProposal,
  ProviderCapabilityReport,
  VisualCapabilityStatus,
  TruthfulnessState,
} from './types.js';
import type { ValidatedImage } from './security.js';

function correlationId(): string {
  return newId('vis');
}

// ---------------------------------------------------------------------------
// Metadata extraction (deterministic, from validated image)
// ---------------------------------------------------------------------------

export function extractImageMetadata(image: ValidatedImage): ImageMetadata {
  const rawFormat = image.metadata.format;
  const format = (rawFormat.startsWith('image/') ? rawFormat.slice('image/'.length) : rawFormat) as ImageMetadata['format'];
  return {
    format,
    width: image.metadata.width,
    height: image.metadata.height,
    colorSpace: (image.metadata.colorSpace as ImageMetadata['colorSpace']) ?? 'unknown',
    hasAlpha: image.metadata.hasAlpha,
    fileSizeBytes: image.buffer.length,
    mimeType: image.mimeType,
  };
}

// ---------------------------------------------------------------------------
// Honest heuristics (metadata-only, never claims pixel understanding)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<VisualFinding['severity'], number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Derive layout/dimension heuristics from metadata alone. These are labeled with
 * state=HEURISTIC and explicit limitations so they are never mistaken for real
 * visual understanding.
 */
export function heuristicUIAnalysis(image: ValidatedImage): Omit<UIAnalysisResult, 'correlationId' | 'generatedAt' | 'id'> {
  const metadata = extractImageMetadata(image);
  const findings: VisualFinding[] = [];
  const components: UIComponent[] = [];
  const texts: UITextRegion[] = [];
  const defects: VisualFinding[] = [];

  const w = metadata.width;
  const h = metadata.height;

  if (w !== null && h !== null) {
    const aspect = w / h;
    // Portrait / landscape heuristic (metadata only).
    const orientation = aspect > 1.2 ? 'landscape' : aspect < 0.8 ? 'portrait' : 'square';
    findings.push({
      id: newId('vfd'),
      type: 'ORIENTATION',
      severity: 'LOW',
      title: 'Orientation heuristic',
      description: `Image is ${orientation} (aspect ratio ${aspect.toFixed(2)}). Metadata-derived only; no pixel content understood.`,
      confidence: 0.6,
      evidence: `width=${w}, height=${h}`,
    });
  } else {
    findings.push({
      id: newId('vfd'),
      type: 'DIMENSIONS_UNKNOWN',
      severity: 'LOW',
      title: 'Dimensions unavailable',
      description: 'Image dimensions could not be determined from the header.',
      confidence: 1,
      evidence: 'no SOF/IHDR/VP8 segment found',
    });
  }

  components.push({
    id: newId('vcp'),
    type: 'image',
    x: 0,
    y: 0,
    width: w ?? 0,
    height: h ?? 0,
    confidence: 1,
  });

  if (metadata.hasAlpha) {
    defects.push({
      id: newId('vdf'),
      type: 'ALPHA_CHANNEL',
      severity: 'LOW',
      title: 'Alpha channel present',
      description: 'Image contains transparency, which may complicate layout or export.',
      confidence: 1,
      evidence: `colorSpace=${metadata.colorSpace}, hasAlpha=true`,
    });
  }

  return {
    type: 'UI',
    state: 'HEURISTIC',
    metadata,
    findings,
    confidence: 0.4,
    provider: 'local-heuristics',
    limitations: [
      'No real vision provider: content is NOT understood from pixels.',
      'Analysis is metadata/heuristic only (dimensions, aspect ratio, color model).',
      'Component detection is a single full-image box; no real element segmentation.',
      'No OCR: text regions are empty unless a real OCR engine is configured.',
    ],
    regions: findings,
    components,
    texts,
    layout: layoutLabel(w, h),
    hierarchy: ['root'],
    defects,
  };
}

function layoutLabel(w: number | null, h: number | null): string {
  if (w === null || h === null) return 'unknown';
  const aspect = w / h;
  if (aspect > 2.5) return 'wide/banner';
  if (aspect < 0.5) return 'narrow/tall';
  return aspect > 1 ? 'landscape' : 'portrait';
}

export function severityRank(f: VisualFinding): number {
  return SEVERITY_ORDER[f.severity];
}

// ---------------------------------------------------------------------------
// Provider capability detection (honest, consults real environment)
// ---------------------------------------------------------------------------

export async function getVisionCapability(userId: string): Promise<{ status: VisualCapabilityStatus; models: number }> {
  const vision = await eligibleModels(userId, { needsVision: true });
  if (vision.length === 0) return { status: 'ENVIRONMENT_BLOCKED', models: 0 };
  return { status: 'AVAILABLE', models: vision.length };
}

export function getOCRCapability(): { status: VisualCapabilityStatus; engines: number } {
  // No OCR engine exists in this environment (audit). Honest.
  return { status: 'UNAVAILABLE', engines: 0 };
}

export function getPixelComparisonCapability(): VisualCapabilityStatus {
  // No image-processing library; pixel diff not implemented.
  return 'NOT_IMPLEMENTED';
}

export function getMultimodalCapability(models: number): VisualCapabilityStatus {
  return models > 0 ? 'AVAILABLE' : 'ENVIRONMENT_BLOCKED';
}

export async function getProviderCapabilities(userId: string): Promise<ProviderCapabilityReport> {
  const vision = await getVisionCapability(userId);
  const multimodalStatus = getMultimodalCapability(vision.models);
  return {
    vision: vision.status,
    ocr: getOCRCapability().status,
    multimodal: multimodalStatus,
    pixelComparison: getPixelComparisonCapability(),
    screenshotUnderstanding: vision.status === 'AVAILABLE' ? 'AVAILABLE' : 'ENVIRONMENT_BLOCKED',
    visualDebugging: vision.status === 'AVAILABLE' ? 'AVAILABLE' : 'ENVIRONMENT_BLOCKED',
    uiToCode: 'AVAILABLE', // advisory-only, always B1 reviewed
    uiAnalysis: vision.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
    limitations: [
      vision.models === 0
        ? 'No vision-capable AI model is configured on this server.'
        : 'Vision analysis requires the configured vision provider and is routed through the AI Gateway.',
      'No OCR engine is installed on this server.',
      'Pixel-level comparison is not implemented (no image-processing library).',
      'Any UI/heuristic result is metadata-derived and NOT pixel understanding.',
    ],
    details: {
      visionModels: vision.models,
      ocrEngines: getOCRCapability().engines,
      imageProcessing: false,
      realProvider: vision.models > 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Advisory code proposal construction
// ---------------------------------------------------------------------------

export function buildCodeProposal(
  analysis: VisualAnalysisResult | UIAnalysisResult,
  targetLanguage: string,
): CodeProposal {
  const evidence: string[] = [];
  for (const f of analysis.findings) {
    if (f.evidence) evidence.push(`${f.type}: ${f.evidence}`);
  }
  if (analysis.metadata) {
    evidence.push(
      `image ${analysis.metadata.width ?? '?'}x${analysis.metadata.height ?? '?'} ${analysis.metadata.format} (${analysis.metadata.fileSizeBytes} bytes)`,
    );
  }

  let code = '';
  const language = targetLanguage.toLowerCase();
  if (language === 'typescript' || language === 'ts') {
    code = `// Advisory placeholder for ${analysis.type} analysis.
// state: ${analysis.state}, provider: ${analysis.provider}
export interface AnalyzedImage {
  format: string;
  width: number | null;
  height: number | null;
  colorSpace: string;
}

export const analyzedImage: AnalyzedImage = {
  format: ${JSON.stringify(analysis.metadata?.format ?? 'unknown')},
  width: ${analysis.metadata?.width ?? 'null'},
  height: ${analysis.metadata?.height ?? 'null'},
  colorSpace: ${JSON.stringify(analysis.metadata?.colorSpace ?? 'unknown')},
};
`;
  } else {
    code = `// Advisory placeholder for ${analysis.type} (${language} target).
// state: ${analysis.state}. No pixels were understood; this scaffold is descriptive only.`;
  }

  return {
    id: newId('vcp'),
    language,
    code,
    description: `Advisory ${language} scaffold derived from ${analysis.type} analysis (state=${analysis.state}).`,
    evidence,
    assumptions: [
      'The analysis was metadata/heuristic only; it did not understand image content.',
      'The generated code is a descriptive scaffold, NOT a rest animation or layout reconstruction.',
      'Applying this proposal to any project requires the B1 cowork review flow; it is never auto-applied.',
    ],
    riskLevel: 'HIGH',
    reviewRequired: true,
    reviewTarget: 'COWORK_REVIEW',
    correlationId: analysis.correlationId,
  };
}

// ---------------------------------------------------------------------------
// Diagram (Mermaid text) parsing → structured model → code
// ---------------------------------------------------------------------------

export interface ParsedDiagramNode {
  id: string;
  label: string;
}

export interface ParsedDiagramEdge {
  from: string;
  to: string;
}

export interface DiagramStructure {
  type: string;
  nodes: ParsedDiagramNode[];
  edges: ParsedDiagramEdge[];
  root: string | null;
}

const MT_NODE = /^([A-Za-z0-9_-]+)\s*\["?([^\]"]*)"?\]/;
const MT_NODE_SHORT = /^([A-Za-z0-9_-]+)\s*\("?([^)"]*)"?\)/;

export function parseDiagramToStructure(diagramType: string, content: string): DiagramStructure {
  const nodes: ParsedDiagramNode[] = [];
  const edges: ParsedDiagramEdge[] = [];
  const nodeSet = new Set<string>();
  let root: string | null = null;

  const ensureNode = (id: string, label: string): string => {
    const cleanBase = id.replace(/[^A-Za-z0-9_-]/g, '');
    const clean = cleanBase || `n${nodes.length}`;
    if (!nodeSet.has(clean)) {
      nodes.push({ id: clean, label: label || clean });
      nodeSet.add(clean);
    }
    return clean;
  };

  const statements: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    for (const stmt of line.split(';')) statements.push(stmt.trim());
  }

  for (const stmt of statements) {
    if (!stmt) continue;
    // Skip Mermaid directives/headers.
    if (
      /^(stateDiagram|flowchart|graph|sequenceDiagram|classDiagram|erDiagram|sequence|journey|pie|gantt|gitgraph)\b/i.test(stmt)
    ) {
      continue;
    }

    // Edge: "A --> B", "A -->|label| B", "A[Start] --> B[Process]", "A --> B: note"
    const arrowIndex = stmt.search(/-?>/);
    if (arrowIndex !== -1) {
      const leftRaw = stmt.slice(0, arrowIndex).replace(/-*$/, '').trim();
      const rightRaw = stmt.slice(arrowIndex + 2).replace(/^-+/, '').trim();
      const fromId = nodeIdOf(leftRaw);
      const toId = nodeIdOf(rightRaw.split(':')[0]!.trim());
      if (fromId && toId) {
        const from = ensureNode(fromId, labelOf(leftRaw) ?? fromId);
        const to = ensureNode(toId, labelOf(rightRaw) ?? toId);
        edges.push({ from, to });
      }
      continue;
    }

    // Node declaration: "Id[label]" or "Id(label)"
    const nodeMatch = MT_NODE.exec(stmt) || MT_NODE_SHORT.exec(stmt);
    if (nodeMatch) {
      const id = ensureNode(nodeMatch[1]!.trim(), nodeMatch[2]?.trim() ?? '');
      if (!root) root = id;
    }
  }

  return { type: diagramType, nodes, edges, root };
}

function nodeIdOf(s: string): string | null {
  const m = /^[A-Za-z0-9_-]+/.exec(s);
  return m ? m[0].replace(/[^A-Za-z0-9_-]/g, '') : null;
}

function labelOf(s: string): string | null {
  const bracket = /\["?([^\]"]*)"?\]/.exec(s) || /\(([^)]*)\)/.exec(s);
  const inner = bracket?.[1]?.trim();
  return inner ? inner : null;
}

export function diagramToCode(model: DiagramStructure, targetLanguage: string): CodeProposal {
  const language = targetLanguage.toLowerCase();
  const nodeIds = model.nodes.map((n) => n.id);
  const edges = model.edges.map((e) => ({ from: e.from, to: e.to }));

  let code = '';
  if (language === 'typescript' || language === 'ts') {
    code = `// Advisory state/flow scaffold derived from ${model.type} diagram (B1 review required).
export type NodeId = ${nodeIds.map((n) => JSON.stringify(n)).join(' | ') || 'string'};

export interface Edge { from: NodeId; to: NodeId; }

export const nodes: NodeId[] = ${JSON.stringify(nodeIds, null, 2)};

export const edges: Edge[] = ${JSON.stringify(edges, null, 2)};

export const root: NodeId | null = ${JSON.stringify(model.root)};
`;
  } else {
    code = `// Advisory scaffold for ${model.type} diagram (${language}).\n` +
      `// ${model.nodes.length} nodes, ${model.edges.length} edges, root=${model.root ?? 'none'}.`;
  }

  return {
    id: newId('vcp'),
    language,
    code,
    description: `Advisory ${language} state/flow scaffold parsed from a ${model.type} Mermaid diagram.`,
    evidence: [
      `parsed ${model.nodes.length} nodes and ${model.edges.length} edges from diagram text`,
      `root node: ${model.root ?? 'none'}`,
    ],
    assumptions: [
      'Parse is structural (node/edge extraction from Mermaid text); it does not infer semantics.',
      'Generated code is an advisory scaffold and must go through B1 review before any project use.',
    ],
    riskLevel: 'MEDIUM',
    reviewRequired: true,
    reviewTarget: 'COWORK_REVIEW',
    correlationId: correlationId(),
  };
}

export function validateDiagramContent(content: string, diagramType: string): void {
  if (!content.trim()) throw AppError.badRequest('diagram_empty', 'Diagram content is empty');
  if (content.length > 200000) throw AppError.badRequest('diagram_too_large', 'Diagram content exceeds 200KB');
  const detected = /<(script|iframe)\b/i.test(content);
  if (detected) {
    throw AppError.badRequest('diagram_injection', 'Diagram content contains disallowed markup');
  }
  void diagramType;
}
