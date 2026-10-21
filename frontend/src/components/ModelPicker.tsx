/**
 * CodeConClave — ModelPicker: compact model control in the chat composer.
 * Reads the AI registry (GET /api/v1/ai/models — the backend is the ONLY
 * authority on availability) and stores the choice. The first option is AUTO:
 * the Model Routing engine (Model Routing 2026) picks the best model per task.
 * An explanation popover shows why a model was chosen (from GET /api/v1/ai/routing)
 * — reasons are concise and never leak secrets. No model is invented, and the
 * server's lock/down state is honored — a locked or down model is disabled,
 * never selected silently.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { AiModel } from '../lib/types';

const TIER_ORDER: AiModel['tier'][] = ['PREMIUM', 'CAPABLE', 'EFFICIENT'];
const TIER_LABEL: Record<AiModel['tier'], string> = {
  PREMIUM: 'Reasoning — premium complex work',
  CAPABLE: 'Coding — balanced',
  EFFICIENT: 'Fast — efficient',
};
const CLASS_LABEL: Record<AiModel['computeClass'], string> = {
  A: 'fast',
  B: 'balanced',
  C: 'max capability',
};

const CAPABILITY_TAG: Record<string, string> = {
  MULTIMODAL_MODEL: 'vision',
  IMAGE_GENERATOR: 'image',
  EXTERNAL_AGENT: 'agent',
};

const KEY_STATE_HINT: Record<string, string> = {
  KEY_INVALID: 'key invalid',
  ENVIRONMENT_BLOCKED: 'env blocked',
  UNVERIFIED: 'unverified',
  MISSING_KEY: 'not configured',
  PROVIDER_UNAVAILABLE: 'unavailable',
};

interface ProviderRow {
  providerId: string;
  keyState: string;
  /** Server snapshot status (AVAILABLE / RATE_LIMITED / QUOTA_EXHAUSTED / …). */
  status?: string;
}

function stateNoteFor(providerId: string, map: Record<string, string>): string {
  const hint = map[providerId] ? KEY_STATE_HINT[map[providerId]] : undefined;
  return hint ? ` · ${hint}` : '';
}

/** Precise provider-state note from the server snapshot. Takes precedence over
    the coarse model-health note: a rate-limited provider is transiently
    throttled (retry later — never a CodeConClave billing failure), which reads
    very differently from a degraded one. */
function snapshotNoteFor(providerId: string, map: Record<string, string>): string | null {
  const status = map[providerId];
  if (status === 'RATE_LIMITED') return ' · rate limited — retry later';
  if (status === 'QUOTA_EXHAUSTED') return ' · quota exhausted — provider billing';
  return null;
}

/** Honest capability chip: derived only from the backend-registered class. */
function capabilityTag(m: AiModel): string {
  const classTag = CAPABILITY_TAG[m.capabilityClass ?? ''] ?? (m.capabilityCategory === 'EXTERNAL_AGENT' ? 'agent' : '');
  const extra = m.imageGeneration || m.imageEditing ? 'image' : '';
  if (classTag && extra && classTag !== extra) return `${classTag}+${extra}`;
  return classTag || extra;
}

/** Provider key states under which no model on that provider can serve. */
const DEAD_KEY = new Set(['KEY_INVALID', 'MISSING_KEY', 'ENVIRONMENT_BLOCKED', 'PROVIDER_UNAVAILABLE']);
/** Provider snapshot states under which no model on that provider can serve now. */
const DEAD_SNAPSHOT = new Set(['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'DOWN', 'DEGRADED', 'OFFLINE', 'FAILED']);

/** AUTO sentinel: empty string means "let the router decide". */
export const AUTO_MODEL = '';

/**
 * Show ONLY models the user can actually use right now: available, healthy,
 * and unlocked. Anything else (down, degraded, locked, unconfigured
 * provider) is hidden rather than shown-disabled — the picker lists what you
 * have, nothing you can't touch.
 */
function usable(m: AiModel): boolean {
  return m.available && m.health !== 'DOWN' && m.health !== 'DEGRADED' && !m.locked;
}

interface RoutingPreview {
  reason?: string;
  selectedModel?: string;
  selectedProvider?: string;
  taskType?: string;
  capabilityMatch?: boolean;
  routingPreference?: string;
  estimatedCost?: number | null;
}

export function ModelPicker({
  value,
  onChange,
  onRouting,
  residentOnly,
  onResidentStatus,
}: {
  value: string | undefined;
  onChange: (modelId: string) => void;
  /** Real routing context for the surrounding composer (provider/model/reason). */
  onRouting?: (r: { provider?: string; model?: string; reason?: string } | null) => void;
  /** Home screens show ONLY CodeConClave AI — one AI, router picks 1 driver per task. */
  residentOnly?: boolean;
  /** Reports whether any resident driver can actually answer (server probe). */
  onResidentStatus?: (ready: boolean) => void;
}) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>();
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [providerState, setProviderState] = useState<Record<string, string>>({});
  const [providerSnapshot, setProviderSnapshot] = useState<Record<string, string>>({});
  // null = not known yet. CodeConClave AI is offered only when the server's
  // probe says at least one tuned driver is reachable — never as decoration.
  const [residentReady, setResidentReady] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ status: { anyReady?: boolean } }>('/api/v1/ai/resident/status')
      .then((res) => {
        if (!active) return;
        const ready = res?.status?.anyReady === true;
        setResidentReady(ready);
        onResidentStatus?.(ready);
      })
      .catch(() => {
        if (!active) return;
        setResidentReady(false);
        onResidentStatus?.(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    void api<{ providers: ProviderRow[] }>('/api/v1/ai/providers')
      .then((res) => {
        if (!active) return;
        const keyMap: Record<string, string> = {};
        const statusMap: Record<string, string> = {};
        for (const p of res?.providers ?? []) {
          keyMap[p.providerId] = p.keyState;
          if (p.status) statusMap[p.providerId] = p.status;
        }
        setProviderState(keyMap);
        setProviderSnapshot(statusMap);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setPreview(null);
    void api<{ models: AiModel[]; defaultModel: string | null; configuredProviders?: string[] }>('/api/v1/ai/models')
      .then((res) => {
        if (!active) return;
        // Show only the providers this deployment actually has configured
        // (server-authoritative). Absent field = old server, show everything.
        // Usability filtering (health/lock/key/snapshot) happens at render
        // time in `visible` so both fetches combine regardless of order.
        const configured = Array.isArray(res.configuredProviders) ? new Set(res.configuredProviders) : null;
        setModels((res.models ?? []).filter((m) => !configured || configured.has(m.providerId)));
        setDefaultModel(res.defaultModel ?? undefined);
      })
      .catch(() => undefined);
    // When AUTO is active, surface the routing explanation for this turn.
    if (!value) {
      void api<{ decision: RoutingPreview }>('/api/v1/ai/routing')
        .then((res) => {
          if (!active) return;
          if (res.decision) {
            setPreview(res.decision);
            onRouting?.({
              provider: res.decision.selectedProvider,
              model: res.decision.selectedModel,
              reason: res.decision.reason,
            });
          }
        })
        .catch(() => undefined);
    } else {
      onRouting?.(null);
    }
    return () => {
      active = false;
    };
  }, [value]);

  // CodeConclave AI first: your 5 resident drivers behind one Auto router
  // (Sai hashes + Dispatch 1-role-1-run). Frontend-only entry — the server
  // registry CHECK stays untouched; empty id still means AUTO gateway.
  const RESIDENT: AiModel = {
    id: 'codeconclave-ai',
    providerId: 'resident',
    label: 'CodeConClave AI',
    description: 'Your 5 tuned drivers — router picks 1 per task',
    tier: 'CAPABLE',
    computeClass: 'B',
    health: 'HEALTHY',
    locked: false,
    available: true,
    capabilityCategory: 'MODEL',
    capabilityClass: 'NORMAL_MODEL',
  };

  // The list the user asked for: only models that can actually serve now —
  // usable row AND a live provider (no dead key, no dead snapshot). Unknown
  // provider state falls back to the row flags (never hide on missing data).
  const visible = useMemo(() => {
    const rows = models.filter((m) => {
      if (!usable(m)) return false;
      const ks = providerState[m.providerId];
      if (ks && DEAD_KEY.has(ks)) return false;
      const snap = providerSnapshot[m.providerId];
      if (snap && DEAD_SNAPSHOT.has(snap)) return false;
      return true;
    });
    const resident = residentReady ? [RESIDENT] : [];
    if (residentOnly) return resident;
    return [...resident, ...rows.filter((m) => m.id !== RESIDENT.id)];
  }, [models, providerState, providerSnapshot, residentOnly, residentReady]);

  useEffect(() => {
    const current = visible.find((m) => m.id === value);
    const fallback = visible.find(usable);
    if ((!current || !usable(current)) && (fallback || defaultModel !== undefined)) {
      onChange(fallback ? fallback.id : (defaultModel ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, value, defaultModel]);

  const interim = preview ? `Router: ${preview.reason ?? 'automatic routing'}` : 'automatic routing';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={interim}>
      <select
        className="cc-select cc-model-select"
        value={value ?? AUTO_MODEL}
        aria-label="Model"
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={AUTO_MODEL}>AUTO</option>
        {residentOnly && residentReady === false && (
          <option value="" disabled>
            CodeConClave AI — not running (no model host connected)
          </option>
        )}
        {visible.length === 0 && !residentOnly && (
          <option value="" disabled>
            No models available — connect a provider
          </option>
        )}
        {TIER_ORDER.map((tier) => {
          const group = visible.filter((m) => m.tier === tier);
          if (group.length === 0) return null;
          return (
            <optgroup key={tier} label={TIER_LABEL[tier]}>
              {group.map((m) => {
                const snapshotNote = snapshotNoteFor(m.providerId, providerSnapshot);
                const stateNote = stateNoteFor(m.providerId, providerState);
                const tagNote = capabilityTag(m) ? ` · ${capabilityTag(m)}` : '';
                const meta = `${CLASS_LABEL[m.computeClass]}${m.description ? ` — ${m.description}` : ''}`;
                return (
                  <option key={m.id} value={m.id} title={`${meta}${snapshotNote ?? ''}${stateNote}${tagNote ? ` · ${tagNote}` : ''}`}>
                    {m.label} ({m.providerId})
                    {snapshotNote}
                    {stateNote}
                    {tagNote}
                  </option>
                );
              })}
            </optgroup>
          );
        })}
      </select>
      {value === AUTO_MODEL && preview && (
        <span aria-label="Routing explanation" className="cc-muted" title={interim}>
          {(preview.selectedModel ?? '').length > 0
            ? `${preview.selectedProvider ?? ''}/${preview.selectedModel ?? ''}`
            : 'AUTO'}
        </span>
      )}
    </span>
  );
}