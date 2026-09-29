/**
 * CodeConClave — Developer Workflow & Release Operations Service (PKG-17).
 * Orchestrates the ten developer-workflow + deployment/release-intelligence
 * capabilities and exposes an honest capability report. All findings are
 * deterministic and advisory; no deployment, command, or workspace write is
 * performed.
 */
import { AppError } from '../../shared/errors.js';
import type {
  CapabilityStatus,
  DevWorkflowCapabilityReport,
  DevWorkflowKind,
  TruthfulnessState,
} from './types.js';

export const ALL_KINDS: DevWorkflowKind[] = [
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
];

export const KIND_DESCRIPTIONS: Record<DevWorkflowKind, string> = {
  MIGRATION_AGENT:
    'Advisory workspace/codebase migration plan (move/rename/rewrite/verify steps with risk) derived from static stack detection.',
  DOC_DRIFT:
    'Detects documentation drift against source: referenced symbols/files that no longer exist, plus missing-doc signals.',
  CONTEXTUAL_DEBUG:
    'From an error signature, surfaces contextually relevant source clues with hypothesized causes and recommendations.',
  HOTSPOT_PROFILER:
    'Ranks performance hotspots from the performance oracle (slow functions, N+1, API latency) as an actionable surface.',
  BRANCH_STRATEGY:
    'Recommends a branching/merge strategy from workspace structure and team-size signals.',
  ROLLBACK_PREDICTOR:
    'Scores rollback readiness/risk from change signals (migrations, config churn, commit pair).',
  HOTFIX_FAST_TRACK:
    'Produces a minimal-change hotfix plan for an incident (smallest surface, containment, quick verify, observe).',
  FEATURE_FLAG_ORCH:
    'Inventories feature-flag conditionals in source and classifies lifecycle/rollout guidance.',
  HEALTH_DASHBOARD:
    'Aggregates static workspace dev-health signals (tests, lint, build config, deps, CI, docs) into a score.',
  ERROR_RECOVERY_PLAYBOOK:
    'Generates an advisory recovery playbook (diagnose/prevent/remediate/rollback/verify) for an error signature.',
};

export class DeveloperWorkflowService {
  getCapabilities(): DevWorkflowCapabilityReport {
    const status: CapabilityStatus = 'AVAILABLE';
    const state: TruthfulnessState = 'HEURISTIC';
    const capabilities = {} as DevWorkflowCapabilityReport['capabilities'];
    for (const k of ALL_KINDS) {
      capabilities[k] = {
        status,
        state,
        deterministic: true,
        needsProvider: false,
        description: KIND_DESCRIPTIONS[k],
      };
    }
    return {
      capabilities,
      limitations: [
        'All analyses are deterministic heuristics over static source — advisory guidance, not proof.',
        'None of these capabilities execute deployments, commands, or workspace writes; no provider is contacted.',
        'Runtime/build/test results are NOT measured; statuses infer structure only.',
        'No optimization, migration, or rollback is auto-applied.',
      ],
    };
  }

  assertKind(kind: string): DevWorkflowKind {
    if (!(ALL_KINDS as string[]).includes(kind)) {
      throw AppError.badRequest('devworkflow_unknown_kind', `Unknown capability kind: ${kind}`);
    }
    return kind as DevWorkflowKind;
  }
}

export const developerWorkflowService = new DeveloperWorkflowService();