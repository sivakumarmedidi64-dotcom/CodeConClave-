/**
 * CodeConClave — PKG-17 Developer Workflow & Release Operations panel.
 * Honest, server-authoritative DEVELOPER WORKFLOW + DEVELOPMENT EXECUTION +
 * DEPLOYMENT/RELEASE OPERATIONS intelligence: Workspace Migration Agent (#29),
 * Documentation Drift Detector (#34), Contextual Debugging (#41), Hotspot
 * Profiler (#44), Branch Strategy (#31), Rollback Predictor (#32), Hotfix
 * Fast-Track (#33), Feature Flag Orchestrator (#35), Workspace Health Dashboard
 * (#43), Error Recovery Playbook (#45). All reports are advisory heuristics with
 * truthfulness state — none execute deployments, commands, or writes.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Kind =
  | 'MIGRATION_AGENT'
  | 'DOC_DRIFT'
  | 'CONTEXTUAL_DEBUG'
  | 'HOTSPOT_PROFILER'
  | 'BRANCH_STRATEGY'
  | 'ROLLBACK_PREDICTOR'
  | 'HOTFIX_FAST_TRACK'
  | 'FEATURE_FLAG_ORCH'
  | 'HEALTH_DASHBOARD'
  | 'ERROR_RECOVERY_PLAYBOOK';

interface CapEntry {
  status: string;
  state: string;
  deterministic: boolean;
  needsProvider: boolean;
  description: string;
}
interface DevCaps {
  capabilities: Record<Kind, CapEntry>;
  limitations: string[];
}

interface SimpleReport {
  id: string;
  state: string;
  limitations?: string[];
  [key: string]: unknown;
}

const KIND_LABEL: Record<Kind, string> = {
  MIGRATION_AGENT: 'Workspace Migration Agent',
  DOC_DRIFT: 'Documentation Drift Detector',
  CONTEXTUAL_DEBUG: 'Contextual Debugging',
  HOTSPOT_PROFILER: 'Hotspot Profiler',
  BRANCH_STRATEGY: 'Branch Strategy Optimizer',
  ROLLBACK_PREDICTOR: 'Rollback Predictor',
  HOTFIX_FAST_TRACK: 'Hotfix Fast-Track',
  FEATURE_FLAG_ORCH: 'Feature Flag Orchestrator',
  HEALTH_DASHBOARD: 'Workspace Health Dashboard',
  ERROR_RECOVERY_PLAYBOOK: 'Error Recovery Playbook',
};

const STATE_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic only',
  PROVIDER_REQUIRED: 'provider required',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  UNAVAILABLE: 'unavailable',
};

// Kinds that require a free-text signature/title input.
const INPUT_KINDS: Partial<Record<Kind, string>> = {
  CONTEXTUAL_DEBUG: 'Error signature (e.g. "Error: token expired")',
  HOTFIX_FAST_TRACK: 'Incident title (e.g. "CRITICAL outage in billing API")',
  ERROR_RECOVERY_PLAYBOOK: 'Error signature (e.g. "deployment failed health check 503")',
};

const ALL_KINDS: Kind[] = [
  'MIGRATION_AGENT',
  'DOC_DRIFT',
  'CONTEXTUAL_DEBUG',
  'HOTSPOT_PROFILER',
  'BRANCH_STRATEGY',
  'ROLLBACK_PREDICTOR',
  'HOTFIX_FAST_TRACK',
  'FEATURE_FLAG_ORCH',
  'HEALTH_DASHBOARD',
  'ERROR_RECOVERY_PLAYBOOK',
];

const ENDPOINT: Record<Kind, string> = {
  MIGRATION_AGENT: '/migration',
  DOC_DRIFT: '/doc-drift',
  CONTEXTUAL_DEBUG: '/contextual-debug',
  HOTSPOT_PROFILER: '/hotspot-profiler',
  BRANCH_STRATEGY: '/branch-strategy',
  ROLLBACK_PREDICTOR: '/rollback-predictor',
  HOTFIX_FAST_TRACK: '/hotfix',
  FEATURE_FLAG_ORCH: '/feature-flags',
  HEALTH_DASHBOARD: '/health-dashboard',
  ERROR_RECOVERY_PLAYBOOK: '/error-runbook',
};

export function DeveloperWorkflowPanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<DevCaps | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState('Error: token expired');
  const [reports, setReports] = useState<Partial<Record<Kind, SimpleReport>>>({});

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const c = await api<DevCaps>('/api/v1/developer-workflow/capabilities');
      setCaps(c);
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const bodyFor = useCallback(
    (kind: Kind) => {
      if (INPUT_KINDS[kind]) {
        return { projectId, errorSignature: signature, incidentTitle: signature };
      }
      return { projectId };
    },
    [projectId, signature],
  );

  const run = useCallback(
    async (kind: Kind) => {
      setBusy(true);
      setError(null);
      try {
        const rep = await api<SimpleReport>('/api/v1/developer-workflow' + ENDPOINT[kind], {
          method: 'POST',
          body: bodyFor(kind),
        });
        setReports((prev) => ({ ...prev, [kind]: rep }));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Assessment failed');
      } finally {
        setBusy(false);
      }
    },
    [bodyFor],
  );

  return (
    <div data-testid="devworkflow-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Developer Workflow &amp; Release Operations</h2>

      <section data-testid="devworkflow-capabilities" className="rounded border p-3">
        <h3 className="text-sm font-medium">Developer workflow + deploy/release capabilities</h3>
        {capsState === 'loading' && <p data-testid="devworkflow-caps-loading">Loading capability status…</p>}
        {capsState === 'error' && <p data-testid="devworkflow-caps-error">Could not load capability status.</p>}
        {capsState === 'ready' && caps && (
          <div className="mt-2 space-y-2 text-sm">
            <label className="block text-xs text-gray-600">
              Error / incident signature (used by contextual debug, hotfix, error runbook):
              <input
                data-testid="devworkflow-signature"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-xs"
              />
            </label>
            {ALL_KINDS.map((kind) => {
              const cap = caps.capabilities[kind];
              return (
                <div key={kind} data-testid={`devworkflow-cap-${kind.toLowerCase()}`} className="flex items-start gap-2">
                  <button
                    data-testid={`devworkflow-run-${kind.toLowerCase()}`}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void run(kind)}
                  >
                    {KIND_LABEL[kind]}
                  </button>
                  <div>
                    <div>
                      <span className="text-xs text-gray-500">
                        [{cap?.status ?? 'unknown'} · {STATE_LABEL[cap?.state ?? ''] ?? cap?.state ?? 'unknown'}]
                      </span>
                    </div>
                    <p data-testid={`devworkflow-desc-${kind.toLowerCase()}`} className="text-xs text-gray-600">
                      {cap?.description ?? ''}
                    </p>
                  </div>
                </div>
              );
            })}
            <p data-testid="devworkflow-honest" className="text-xs text-amber-700">
              Deterministic heuristics over static source. Findings are advisory guidance with truthfulness state —
              no deployment, command, or workspace write is executed; nothing is shown as success before backend
              confirmation.
            </p>
          </div>
        )}
      </section>

      {error && <p data-testid="devworkflow-error" className="text-sm text-red-600">{error}</p>}

      {ALL_KINDS.filter((k) => reports[k]).map((k) => {
        const r = reports[k]!;
        const summary = summarize(k, r);
        return (
          <section key={k} data-testid={`devworkflow-${k.toLowerCase()}-result`} className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">
              {KIND_LABEL[k]} — {summary.title} ({STATE_LABEL[String(r.state)] ?? r.state})
            </h3>
            {summary.extra && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700">{summary.extra}</p>}
          </section>
        );
      })}

      {caps?.limitations?.length ? (
        <p data-testid="devworkflow-limitations" className="text-xs text-amber-700">
          {caps.limitations.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function summarize(kind: Kind, r: SimpleReport): { title: string; extra?: string } {
  switch (kind) {
    case 'MIGRATION_AGENT': {
      const steps = Array.isArray(r.steps) ? (r.steps as { action: string; path: string }[]) : [];
      return {
        title: `${steps.length} migration step(s) · files ${String(r.filesAnalyzed)}`,
        extra: steps.map((s) => `[${s.action}] ${s.path}`).join('\n'),
      };
    }
    case 'DOC_DRIFT': {
      const findings = Array.isArray(r.findings) ? (r.findings as { kind: string; title: string }[]) : [];
      return {
        title: `${findings.length} drift finding(s)`,
        extra: findings.slice(0, 20).map((f) => `[${f.kind}] ${f.title}`).join('\n'),
      };
    }
    case 'CONTEXTUAL_DEBUG': {
      const clues = Array.isArray(r.clues) ? (r.clues as { filePath: string; hypothesizedCause: string }[]) : [];
      return {
        title: `${clues.length} clue(s), match ${String(r.matchType)}`,
        extra: clues.slice(0, 12).map((c) => `${c.filePath || '(no match)'} — ${c.hypothesizedCause}`).join('\n'),
      };
    }
    case 'HOTSPOT_PROFILER': {
      const hs = Array.isArray(r.hotspots) ? (r.hotspots as { label: string; estimatedDurationMs: number }[]) : [];
      return {
        title: `${hs.length} hotspot(s), ~${String(r.totalEstimatedMs)}ms estimated`,
        extra: hs.slice(0, 12).map((h) => `${h.label} — ${h.estimatedDurationMs}ms`).join('\n'),
      };
    }
    case 'BRANCH_STRATEGY':
      return { title: `top recommendation: ${String(r.topRecommendation ?? 'n/a')}` };
    case 'ROLLBACK_PREDICTOR': {
      const signals = Array.isArray(r.signals) ? (r.signals as { label: string }[]) : [];
      return {
        title: `readiness ${String(r.readinessScore)}/100 · risk ${String(r.risk)}`,
        extra: signals.map((s) => `${s.label}`).join('\n'),
      };
    }
    case 'HOTFIX_FAST_TRACK': {
      const steps = Array.isArray(r.steps) ? (r.steps as { order: number; action: string }[]) : [];
      return {
        title: `severity ${String(r.severity)} · risk ${String(r.estimatedRisk)}`,
        extra: steps.map((s) => `${s.order}. ${s.action}`).join('\n'),
      };
    }
    case 'FEATURE_FLAG_ORCH': {
      const flags = Array.isArray(r.flagsInventory) ? (r.flagsInventory as { name: string; lifecycle: string }[]) : [];
      return {
        title: `${flags.length} flag(s), ${String(r.staleCount)} stale`,
        extra: flags.slice(0, 12).map((f) => `${f.name} [${f.lifecycle}]`).join('\n'),
      };
    }
    case 'HEALTH_DASHBOARD': {
      const facets = Array.isArray(r.facets) ? (r.facets as { facet: string; status: string }[]) : [];
      return {
        title: `health ${String(r.score)}/100 · ${String(r.overallStatus)}`,
        extra: facets.map((f) => `${f.facet}: ${f.status}`).join('\n'),
      };
    }
    case 'ERROR_RECOVERY_PLAYBOOK': {
      const steps = Array.isArray(r.steps) ? (r.steps as { order: number; category: string }[]) : [];
      return {
        title: `matched: ${String(r.matchedPattern ?? 'none')}`,
        extra: steps.map((s) => `${s.order}. ${s.category}`).join('\n'),
      };
    }
    default:
      return { title: 'complete' };
  }
}