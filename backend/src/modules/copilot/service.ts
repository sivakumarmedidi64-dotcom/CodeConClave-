/**
 * CodeConClave — PKG-24 AI Developer Copilot — capability report.
 * Honest: reports provider-availability-derived states and never claims a mode
 * is LIVE if there is no real model to serve it. Deterministic capabilities
 * (evidence, memory retrieval, failure diagnosis heuristics, safe proposals)
 * remain available even with no provider; AI-synthesis modes report
 * PROVIDER_REQUIRED / UNAVAILABLE honestly.
 */
import { COPILOT_CONFIG } from './config.js';
import { providerState, type CopilotProviderState, type ProviderReport } from './provider.js';

export interface CopilotModeCapability {
  mode: string;
  available: 'VERIFIED' | 'PROVIDER_REQUIRED' | 'HEURISTIC' | 'BLOCKED' | 'UNAVAILABLE';
  needsProvider: boolean;
  note: string;
}

export interface CopilotCapabilities {
  featureGateEnabled: boolean;
  featureGateKey: string;
  provider: ProviderReport;
  modes: CopilotModeCapability[];
  bounds: {
    maxContextBytes: number;
    maxOutputBytes: number;
    maxMemoryItems: number;
    maxEvidenceItems: number;
    maxTestProposals: number;
    maxDiagnosisClues: number;
  };
  notes: string[];
}

/**
 * Modes and their honest availability semantics. Deterministic/heuristic modes
 * work without a model; model-synthesis modes do not.
 */
function modeCapabilities(provider: CopilotProviderState): CopilotModeCapability[] {
  const live = provider === 'LIVE_PROVIDER' || provider === 'LOCAL_MODEL' || provider === 'FALLBACK';
  const noModel = provider === 'UNAVAILABLE' || provider === 'PROVIDER_REQUIRED';
  const blocked = provider === 'ENVIRONMENT_BLOCKED';

  const synth = (mode: string, note: string): CopilotModeCapability =>
    blocked
      ? { mode, available: 'BLOCKED', needsProvider: true, note: 'Feature gated OFF.' }
      : noModel
        ? { mode, available: 'PROVIDER_REQUIRED', needsProvider: true, note }
        : { mode, available: 'VERIFIED', needsProvider: true, note };

  const heuristic = (mode: string, note: string): CopilotModeCapability =>
    blocked
      ? { mode, available: 'BLOCKED', needsProvider: false, note: 'Feature gated OFF.' }
      : { mode, available: 'VERIFIED', needsProvider: false, note };

  return [
    synth('EXPLAIN', 'Explanation synthesis needs a model; observed/heuristic analysis is always available.'),
    synth('SUGGEST', 'Suggestion synthesis needs a model; evidence-based suggestions remain available.'),
    synth('ASK', 'Project question synthesis needs a model; evidence retrieval always works.'),
    { mode: 'DEBUG', available: live ? 'VERIFIED' : blocked ? 'BLOCKED' : 'HEURISTIC', needsProvider: false, note: 'Failure diagnosis is heuristic and works without a model; a model can refine it.' },
    synth('TEST', 'Test generation proposes; run/verify always works.'),
    { mode: 'REFACTOR', available: live ? 'VERIFIED' : blocked ? 'BLOCKED' : 'HEURISTIC', needsProvider: false, note: 'Refactor proposals are evidence-driven; a model can prepare them.' },
    { mode: 'REVIEW', available: live ? 'VERIFIED' : blocked ? 'BLOCKED' : 'HEURISTIC', needsProvider: false, note: 'Change review uses B1 + diff; a model can draft proposals.' },
    { mode: 'GENERATE', available: live ? 'VERIFIED' : blocked ? 'BLOCKED' : 'PROVIDER_REQUIRED', needsProvider: true, note: 'Code generation requires a model.' },
    heuristic('MEMORY', 'Memory retrieval is deterministic/heuristic and always available.'),
  ];
}

export async function copilotCapabilities(userId: string): Promise<CopilotCapabilities> {
  const provider = await providerState(userId);
  return {
    featureGateEnabled: COPILOT_CONFIG.enabled(),
    featureGateKey: 'AIOS_P2_COPILOT',
    provider,
    modes: modeCapabilities(provider.state),
    bounds: {
      maxContextBytes: COPILOT_CONFIG.maxContextBytes,
      maxOutputBytes: COPILOT_CONFIG.maxOutputBytes,
      maxMemoryItems: COPILOT_CONFIG.maxMemoryItems,
      maxEvidenceItems: COPILOT_CONFIG.maxEvidenceItems,
      maxTestProposals: COPILOT_CONFIG.maxTestProposals,
      maxDiagnosisClues: COPILOT_CONFIG.maxDiagnosisClues,
    },
    notes: [
      'The copilot reuses the existing AI Gateway, PKG-23 memory, PKG-22 workspace, and B1 reviews.',
      'Never confuses deterministic heuristics with live model reasoning.',
      'Memory and repository content are advisory DATA; the copilot never auto-applies source changes.',
    ],
  };
}
