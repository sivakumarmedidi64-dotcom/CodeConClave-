/**
 * CodeConClave — Developer Workflow & Release Operations Types (PKG-17).
 * Canonical types for DEVELOPER WORKFLOW + DEVELOPMENT EXECUTION +
 * DEPLOYMENT/RELEASE OPERATIONS intelligence:
 *   #29 Workspace Migration Agent
 *   #34 Documentation Drift Detector
 *   #41 Contextual Debugging
 *   #44 Hotspot Profiler
 *   #31 Branch Strategy Optimizer
 *   #32 Rollback Predictor
 *   #33 Hotfix Fast-Track
 *   #35 Feature Flag Orchestrator
 *   #43 Workspace Health Dashboard
 *   #45 Error Recovery Playbook
 * Every finding carries an explicit truthfulness state (HEURISTIC / VERIFIED) and
 * a clear advisory marker — none of these analyses execute deployments, commands,
 * or writes; they are guidance only.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capability identity + status
// ---------------------------------------------------------------------------

export const DevWorkflowKind = z.enum([
  'MIGRATION_AGENT',        // #29
  'DOC_DRIFT',              // #34
  'CONTEXTUAL_DEBUG',       // #41
  'HOTSPOT_PROFILER',       // #44
  'BRANCH_STRATEGY',        // #31
  'ROLLBACK_PREDICTOR',     // #32
  'HOTFIX_FAST_TRACK',      // #33
  'FEATURE_FLAG_ORCH',      // #35
  'HEALTH_DASHBOARD',       // #43
  'ERROR_RECOVERY_PLAYBOOK',// #45
]);
export type DevWorkflowKind = z.infer<typeof DevWorkflowKind>;

export const CapabilityStatus = z.enum([
  'AVAILABLE',
  'UNAVAILABLE',
  'ENVIRONMENT_BLOCKED',
  'NOT_IMPLEMENTED',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const TruthfulnessState = z.enum([
  'VERIFIED',
  'HEURISTIC',
  'PROVIDER_REQUIRED',
  'ENVIRONMENT_BLOCKED',
  'UNAVAILABLE',
]);
export type TruthfulnessState = z.infer<typeof TruthfulnessState>;

export const DevWorkflowReportInputSchema = z.object({
  projectId: z.string().min(1).max(200),
});
export type DevWorkflowReportInput = z.infer<typeof DevWorkflowReportInputSchema>;

// ---------------------------------------------------------------------------
// #29 — Workspace Migration Agent
// ---------------------------------------------------------------------------

export interface MigrationStep {
  path: string;
  action: 'MOVE' | 'RENAME' | 'REWRITE' | 'VERIFY' | 'MANUAL' | 'REMOVE';
  reason: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  state: TruthfulnessState;
}

export interface WorkspaceMigrationReport {
  id: string;
  projectId: string;
  generatedAt: string;
  fromStack: string | null;
  toStack: string | null;
  filesAnalyzed: number;
  steps: MigrationStep[];
  totalSteps: number;
  highRiskCount: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #34 — Documentation Drift Detector
// ---------------------------------------------------------------------------

export const DocDriftKind = z.enum([
  'SYMBOL_NOT_FOUND',
  'FILE_NOT_FOUND',
  'STALE_REFERENCE',
  'MISSING_DOCUMENTATION',
]);
export type DocDriftKind = z.infer<typeof DocDriftKind>;

export interface DocDriftFinding {
  id: string;
  docFilePath: string;
  kind: DocDriftKind;
  title: string;
  referenced: string;
  evidence: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  state: TruthfulnessState;
}

export interface DocDriftReport {
  id: string;
  projectId: string;
  generatedAt: string;
  docsScanned: number;
  sourceFilesScanned: number;
  findings: DocDriftFinding[];
  totalFindings: number;
  highSeverityCount: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #41 — Contextual Debugging
// ---------------------------------------------------------------------------

export interface DebugClue {
  id: string;
  filePath: string;
  line: number | null;
  label: string;
  symptom: string;
  hypothesizedCause: string;
  recommendation: string;
  state: TruthfulnessState;
}

export interface ContextualDebugReport {
  id: string;
  projectId: string;
  generatedAt: string;
  errorSignature: string;
  matchType: 'EXACT' | 'HEURISTIC' | 'NONE';
  clues: DebugClue[];
  totalClues: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #44 — Hotspot Profiler
// ---------------------------------------------------------------------------

export interface HotspotEntry {
  id: string;
  filePath: string;
  label: string;
  estimatedDurationMs: number;
  source: 'MEASURED' | 'ESTIMATED' | 'UNKNOWN';
  isHotPath: boolean;
  state: TruthfulnessState;
  evidence: string;
}

export interface HotspotProfilerReport {
  id: string;
  projectId: string;
  generatedAt: string;
  hotspots: HotspotEntry[];
  totalHotspots: number;
  totalEstimatedMs: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #31 — Branch Strategy Optimizer
// ---------------------------------------------------------------------------

export interface BranchRecommendation {
  id: string;
  strategy: string;
  reason: string;
  whenToUse: string;
  concurrencyRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  state: TruthfulnessState;
}

export interface BranchStrategyReport {
  id: string;
  projectId: string;
  generatedAt: string;
  teamSize: number | null;
  releaseCadence: string | null;
  recommendations: BranchRecommendation[];
  topRecommendation: string | null;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #32 — Rollback Predictor
// ---------------------------------------------------------------------------

export interface RollbackSignal {
  label: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  detail: string;
}

export interface RollbackPredictorReport {
  id: string;
  projectId: string;
  generatedAt: string;
  readinessScore: number; // 0..100 (higher = safer to roll back)
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  signals: RollbackSignal[];
  recommendedAction: string;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #33 — Hotfix Fast-Track
// ---------------------------------------------------------------------------

export interface HotfixStep {
  order: number;
  action: string;
  owner: string;
  detail: string;
}

export interface HotfixFastTrackReport {
  id: string;
  projectId: string;
  generatedAt: string;
  incidentTitle: string;
  impactedArea: string | null;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  minimalSurface: string;
  steps: HotfixStep[];
  estimatedRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #35 — Feature Flag Orchestrator
// ---------------------------------------------------------------------------

export interface FlagEntry {
  name: string;
  lifecycle: 'PROPOSED' | 'ACTIVE' | 'RELEASED' | 'STALE';
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  rolloutLevel: string;
  note: string;
}

export interface FeatureFlagOrchestratorReport {
  id: string;
  projectId: string;
  generatedAt: string;
  flagsInventory: FlagEntry[];
  totalFlags: number;
  staleCount: number;
  recommendedAction: string;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #43 — Workspace Health Dashboard
// ---------------------------------------------------------------------------

export interface HealthFacet {
  facet: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'N/A';
  evidence: string;
  state: TruthfulnessState;
}

export interface HealthDashboardReport {
  id: string;
  projectId: string;
  generatedAt: string;
  score: number; // 0..100
  overallStatus: 'HEALTHY' | 'ATTENTION' | 'CRITICAL';
  facets: HealthFacet[];
  filesScanned: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #45 — Error Recovery Playbook
// ---------------------------------------------------------------------------

export interface RecoveryStep {
  order: number;
  action: string;
  category: 'DIAGNOSE' | 'PREVENT' | 'REMEDIATE' | 'ROLLBACK' | 'VERIFY';
  detail: string;
}

export interface ErrorRecoveryPlaybookReport {
  id: string;
  projectId: string;
  generatedAt: string;
  errorSignature: string;
  matchedPattern: string | null;
  steps: RecoveryStep[];
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

export interface DevWorkflowCapabilityReport {
  capabilities: Record<
    DevWorkflowKind,
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