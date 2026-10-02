/**
 * CodeConClave — Security Operations Intelligence Types (PKG-15).
 * Canonical types for Security & Compliance Operational Intelligence:
 * Security Incident Response (#21), API Rate Limit Awareness (#22),
 * Network Resilience Checker (#23), Workspace Compliance Checker (#24).
 * Every assessment carries an explicit truthfulness state so callers never
 * mistake a heuristic for a proven fact.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capability identity + status
// ---------------------------------------------------------------------------

export const SecOpsKind = z.enum([
  'SECURITY_INCIDENT',   // #21
  'RATE_LIMIT_AWARENESS',// #22
  'NETWORK_RESILIENCE',  // #23
  'COMPLIANCE',          // #24
]);
export type SecOpsKind = z.infer<typeof SecOpsKind>;

export const CapabilityStatus = z.enum([
  'AVAILABLE',
  'UNAVAILABLE',
  'ENVIRONMENT_BLOCKED',
  'NOT_IMPLEMENTED',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

/** Truthfulness state attached to every assessment/finding. */
export const TruthfulnessState = z.enum([
  'VERIFIED',       // hard deterministic match
  'HEURISTIC',      // pattern-based, confidence < 1.0
  'PROVIDER_REQUIRED',
  'ENVIRONMENT_BLOCKED',
  'UNAVAILABLE',
]);
export type TruthfulnessState = z.infer<typeof TruthfulnessState>;

// ---------------------------------------------------------------------------
// #21 — Security Incident Response
// ---------------------------------------------------------------------------

export const IncidentSeverity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type IncidentSeverity = z.infer<typeof IncidentSeverity>;

export const IncidentStatus = z.enum([
  'OPEN',           // reported, not yet triaged
  'TRIAGING',       // being analyzed
  'IN_PROGRESS',    // response underway
  'CONTAINED',      // blast radius limited
  'RESOLVED',       // underlying cause addressed
  'CLOSED',         // verified + accepted as resolved
  'FALSE_POSITIVE', // validated as not a real incident
]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const ResponseAction = z.enum([
  'CONTAIN',
  'MITIGATE',
  'REMEDIATE',
  'ACCEPT',
]);
export type ResponseAction = z.infer<typeof ResponseAction>;

export const CreateIncidentSchema = z.object({
  projectId: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  severity: IncidentSeverity.default('MEDIUM'),
  responseAction: ResponseAction.default('REMEDIATE'),
  description: z.string().max(4000).optional().default(''),
  source: z.string().max(200).optional(), // e.g. security scan / manual / api scan
  findingIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  assigneeId: z.string().min(1).max(200).optional(),
});
export type CreateIncident = z.infer<typeof CreateIncidentSchema>;

export const UpdateIncidentSchema = z.object({
  projectId: z.string().min(1).max(200),
  incidentId: z.string().min(1).max(200),
  status: IncidentStatus.optional(),
  severity: IncidentSeverity.optional(),
  responseAction: ResponseAction.optional(),
  assigneeId: z.string().min(1).max(200).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
}).refine((v) => v.status || v.severity || v.responseAction || v.assigneeId !== undefined || v.summary !== undefined, {
  message: 'At least one changeable field must be provided',
});
export type UpdateIncident = z.infer<typeof UpdateIncidentSchema>;

export const ListIncidentsSchema = z.object({
  projectId: z.string().min(1).max(200),
  status: IncidentStatus.optional(),
  severity: IncidentSeverity.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});
export type ListIncidents = z.infer<typeof ListIncidentsSchema>;

export interface IncidentView {
  id: string;
  projectId: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  responseAction: ResponseAction;
  description: string;
  source: string | null;
  findingIds: string[];
  assigneeId: string | null;
  summary: string | null;
  createdBy: string;
  createdById: string;
  createdByEmail: string | null;
  timeline: IncidentEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface IncidentEvent {
  id: string;
  at: string;
  actorId: string;
  kind: 'CREATED' | 'STATUS' | 'SEVERITY' | 'ASSIGN' | 'ACTION' | 'NOTE';
  detail: string;
}

export interface IncidentStats {
  projectId: string;
  total: number;
  byStatus: Record<IncidentStatus, number>;
  bySeverity: Record<IncidentSeverity, number>;
  openHighCritical: number;
}

// ---------------------------------------------------------------------------
// #22 — API Rate Limit Awareness
// ---------------------------------------------------------------------------

export const RateLimitAssessmentSchema = z.object({
  projectId: z.string().min(1).max(200),
  minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
});
export type RateLimitAssessment = z.infer<typeof RateLimitAssessmentSchema>;

export interface EndpointRateLimitAwareness {
  method: string;
  path: string;
  rateLimited: boolean;
  strategy: string;
  limits: { endpoint: string; limit: number; window: string }[];
  failClosed: boolean;
  riskLevel: string;
  state: TruthfulnessState;
  evidence: string;
}

export interface RateLimitAwarenessReport {
  id: string;
  projectId: string;
  generatedAt: string;
  totalEndpoints: number;
  rateLimitedEndpoints: number;
  uncoveredEndpoints: number;
  coveragePercent: number;
  failClosedEndpoints: number;
  failOpenEndpoints: number;
  overall: 'COVERED' | 'PARTIAL' | 'UNCOVERED';
  endpoints: EndpointRateLimitAwareness[];
}

// ---------------------------------------------------------------------------
// #23 — Network Resilience Checker
// ---------------------------------------------------------------------------

export const NetworkResilienceRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  fileIds: z.array(z.string().min(1).max(200)).max(500).optional(),
});
export type NetworkResilienceRequest = z.infer<typeof NetworkResilienceRequestSchema>;

export const ResilienceFacet = z.enum([
  'CIRCUIT_BREAKER',
  'RETRY_BACKOFF',
  'TIMEOUTS',
  'HEALTH_CHECKS',
  'DEPENDENCY_RESILIENCE',
]);
export type ResilienceFacet = z.infer<typeof ResilienceFacet>;

export type FacetResult = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface ResilienceFinding {
  facet: ResilienceFacet;
  status: FacetResult;
  state: TruthfulnessState;
  confidence: number;
  title: string;
  evidence: string;
  recommendation: string;
}

export interface NetworkResilienceReport {
  id: string;
  projectId: string;
  generatedAt: string;
  filesScanned: number;
  filesSkipped: number;
  score: number; // 0..100
  findings: ResilienceFinding[];
  byFacet: Record<ResilienceFacet, { status: FacetResult; evidence: string }>;
}

// ---------------------------------------------------------------------------
// #24 — Workspace Compliance Checker
// ---------------------------------------------------------------------------

export const ComplianceRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  forceRefresh: z.boolean().optional().default(false),
});
export type ComplianceRequest = z.infer<typeof ComplianceRequestSchema>;

export const ComplianceCategory = z.enum([
  'POSTURE',
  'SUPPLY_CHAIN',
  'SECRETS',
  'API',
]);
export type ComplianceCategory = z.infer<typeof ComplianceCategory>;

export type ComplianceStatus = 'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'UNKNOWN';

export interface ComplianceItem {
  id: string;
  category: ComplianceCategory;
  status: ComplianceStatus;
  title: string;
  details: string;
  evidence: string;
  remediation: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  state: TruthfulnessState;
}

export interface ComplianceCategorySummary {
  category: ComplianceCategory;
  score: number; // 0..100
  status: ComplianceStatus;
  items: number;
  failing: number;
}

export interface ComplianceReport {
  id: string;
  projectId: string;
  generatedAt: string;
  overallScore: number;
  overallStatus: ComplianceStatus;
  categories: ComplianceCategorySummary[];
  items: ComplianceItem[];
  postureScore: number;
  postureLevel: string;
}

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

export interface SecOpsCapabilityReport {
  capabilities: Record<
    SecOpsKind,
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
