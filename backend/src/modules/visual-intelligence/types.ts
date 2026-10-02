/**
 * CodeConClave — Visual Intelligence Types (PKG-13).
 * Canonical types for image/screenshot/UI/architecture analysis with honest,
 * capability-aware status reporting. No fabricated understanding: every provider
 * result carries an exact capability status so callers never mistake a heuristic
 * or a blocked provider for real vision.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / capability status
// ---------------------------------------------------------------------------

export const VisualAnalysisType = z.enum([
  'SCREENSHOT',
  'UI',
  'DIAGRAM',
  'ARCHITECTURE',
  'STATE_MACHINE',
  'METADATA',
]);
export type VisualAnalysisType = z.infer<typeof VisualAnalysisType>;

export const VisualCapabilityStatus = z.enum([
  'AVAILABLE',
  'UNAVAILABLE',
  'ENVIRONMENT_BLOCKED',
  'NOT_IMPLEMENTED',
]);
export type VisualCapabilityStatus = z.infer<typeof VisualCapabilityStatus>;

/** Truthfulness state attached to every result. */
export const TruthfulnessState = z.enum([
  'VERIFIED',
  'HEURISTIC',
  'PROVIDER_REQUIRED',
  'ENVIRONMENT_BLOCKED',
  'UNAVAILABLE',
]);
export type TruthfulnessState = z.infer<typeof TruthfulnessState>;

// ---------------------------------------------------------------------------
// Image metadata
// ---------------------------------------------------------------------------

export interface ImageMetadata {
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'unknown';
  width: number | null;
  height: number | null;
  colorSpace: 'rgb' | 'rgba' | 'palette' | 'grayscale' | 'unknown';
  hasAlpha: boolean;
  fileSizeBytes: number;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Requests (Zod schemas for runtime validation)
// ---------------------------------------------------------------------------

export const VisualAnalysisRequestSchema = z.object({
  imageFileId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  analysisType: VisualAnalysisType.optional().default('SCREENSHOT'),
  options: z
    .object({
      extractText: z.boolean().optional(),
      detectDefects: z.boolean().optional(),
      extractComponents: z.boolean().optional(),
    })
    .optional(),
});
export type VisualAnalysisRequest = z.infer<typeof VisualAnalysisRequestSchema>;

export const DiagramToCodeRequestSchema = z.object({
  diagramType: z.enum(['flowchart', 'sequence', 'state', 'architecture', 'dependency']),
  content: z.string().min(1).max(200000),
  targetLanguage: z.string().min(1).max(50).default('typescript'),
});
export type DiagramToCodeRequest = z.infer<typeof DiagramToCodeRequestSchema>;

export const CodeProposalRequestSchema = z.object({
  imageFileId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  analysisType: VisualAnalysisType.optional().default('UI'),
  targetLanguage: z.string().min(1).max(50).default('typescript'),
});
export type CodeProposalRequest = z.infer<typeof CodeProposalRequestSchema>;

export const DiagramGenerateRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  type: z.enum([
    'flowchart',
    'sequence',
    'architecture',
    'dependency',
    'database',
    'class',
    'state',
    'er',
    'gantt',
    'pie',
    'gitgraph',
    'journey',
  ]),
  scope: z.string().optional(),
  direction: z.enum(['TB', 'TD', 'LR', 'RL', 'BT']).optional(),
  theme: z.enum(['default', 'dark', 'forest', 'neutral']).optional(),
  includeLegend: z.boolean().optional(),
  maxNodes: z.number().int().min(1).max(500).optional(),
});
export type DiagramGenerateRequest = z.infer<typeof DiagramGenerateRequestSchema>;

export const ArchitectureRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  includeGraph: z.boolean().optional().default(true),
  includeRisks: z.boolean().optional().default(true),
});
export type ArchitectureRequest = z.infer<typeof ArchitectureRequestSchema>;

export const StateMachineRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  scope: z.string().optional(),
});
export type StateMachineRequest = z.infer<typeof StateMachineRequestSchema>;

export const CacheClearRequestSchema = z.object({
  pattern: z.string().min(1).max(1000),
});
export type CacheClearRequest = z.infer<typeof CacheClearRequestSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface VisualFinding {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  description: string;
  confidence: number;
  evidence: string;
}

export interface VisualAnalysisResult {
  id: string;
  type: VisualAnalysisType;
  state: TruthfulnessState;
  metadata: ImageMetadata | null;
  findings: VisualFinding[];
  confidence: number;
  provider: string;
  limitations: string[];
  correlationId: string;
  generatedAt: Date;
}

export interface UIComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface UITextRegion {
  id: string;
  text: string;
  x: number;
  y: number;
  confidence: number;
  source: 'HEURISTIC' | 'OCR';
}

export interface UIAnalysisResult extends VisualAnalysisResult {
  type: 'UI';
  regions: VisualFinding[];
  components: UIComponent[];
  texts: UITextRegion[];
  layout: string;
  hierarchy: string[];
  defects: VisualFinding[];
}

export interface CodeProposal {
  id: string;
  language: string;
  code: string;
  description: string;
  evidence: string[];
  assumptions: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  reviewRequired: boolean;
  reviewTarget: 'COWORK_REVIEW' | 'MANUAL';
  correlationId: string;
}

export interface VisualRegressionResult {
  available: boolean;
  before: ImageMetadata | null;
  after: ImageMetadata | null;
  diff: ImageMetadata | null;
  changes: string[];
  state: TruthfulnessState;
  pixelComparison: boolean;
  limitations: string[];
  correlationId: string;
}

export interface ProviderCapabilityReport {
  vision: VisualCapabilityStatus;
  ocr: VisualCapabilityStatus;
  multimodal: VisualCapabilityStatus;
  pixelComparison: VisualCapabilityStatus;
  screenshotUnderstanding: VisualCapabilityStatus;
  visualDebugging: VisualCapabilityStatus;
  uiToCode: VisualCapabilityStatus;
  uiAnalysis: VisualCapabilityStatus;
  limitations: string[];
  details: {
    visionModels: number;
    ocrEngines: number;
    imageProcessing: boolean;
    realProvider: boolean;
  };
}
