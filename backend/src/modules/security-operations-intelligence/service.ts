/**
 * CodeConClave — Security Operations Intelligence Service (PKG-15).
 * Orchestrates the four Security & Compliance Operational Intelligence
 * capabilities and exposes an honest capability report. All findings are
 * deterministic and advisory.
 */
import { AppError } from '../../shared/errors.js';
import type {
  CapabilityStatus,
  SecOpsCapabilityReport,
  SecOpsKind,
  TruthfulnessState,
} from './types.js';

export const ALL_KINDS: SecOpsKind[] = [
  'SECURITY_INCIDENT',
  'RATE_LIMIT_AWARENESS',
  'NETWORK_RESILIENCE',
  'COMPLIANCE',
];

export const KIND_DESCRIPTIONS: Record<SecOpsKind, string> = {
  SECURITY_INCIDENT:
    'Project-scoped security incident lifecycle (triage, assign, respond, contain, resolve, close) with audit trail.',
  RATE_LIMIT_AWARENESS:
    'Aggregates API endpoint scan data to report which endpoints are rate limited, their strategy/limits, and coverage.',
  NETWORK_RESILIENCE:
    'Deterministic static assessment of network-resilience facets (circuit breaker, retry/backoff, timeouts, health checks, dependency resilience).',
  COMPLIANCE:
    'Aggregates security posture into a cross-cutting compliance score with per-category status and persisted history.',
};

export class SecurityOperationsIntelligenceService {
  getCapabilities(): SecOpsCapabilityReport {
    const status: CapabilityStatus = 'AVAILABLE';
    const state: TruthfulnessState = 'HEURISTIC';
    const capabilities = {} as SecOpsCapabilityReport['capabilities'];
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
        'All assessments are deterministic heuristics — advisory, not proof.',
        '#23 scans source text only; no runtime network or dependency behavior is exercised.',
        '#22/#24 aggregate existing security-intelligence data; provider/network verification is out of scope.',
        'Incident response records status/actions; it never auto-applies destructive changes.',
      ],
    };
  }

  assertKind(kind: string): SecOpsKind {
    if (!(ALL_KINDS as string[]).includes(kind)) {
      throw AppError.badRequest('secops_unknown_kind', `Unknown capability kind: ${kind}`);
    }
    return kind as SecOpsKind;
  }
}

export const securityOperationsService = new SecurityOperationsIntelligenceService();
