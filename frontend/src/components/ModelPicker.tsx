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
import { useEffect, useState } from 'react';
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

/** AUTO sentinel: empty string means "let the router decide". */
export const AUTO_MODEL = '';

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
}: {
  value: string | undefined;
  onChange: (modelId: string) => void;
}) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>();
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [providerState, setProviderState] = useState<Record<string, string>>({});
  const [providerSnapshot, setProviderSnapshot] = useState<Record<string, string>>({});

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
        const configured = Array.isArray(res.configuredProviders) ? new Set(res.configuredProviders) : null;
        const list = (res.models ?? []).filter((m) => !configured || configured.has(m.providerId));
        setModels(list);
        setDefaultModel(res.defaultModel ?? undefined);
        const current = list.find((m) => m.id === value);
        const fallback = list.find(usable);
        if (!current || !usable(current)) {
          onChange(fallback ? fallback.id : (res.defaultModel ?? ''));
        }
      })
      .catch(() => undefined);
    // When AUTO is active, surface the routing explanation for this turn.
    if (!value) {
      void api<{ decision: RoutingPreview }>('/api/v1/ai/routing')
        .then((res) => {
          if (!active) return;
          if (res.decision) setPreview(res.decision);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [value]);

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
        {models.length === 0 && <option value="" disabled>model…</option>}
        {TIER_ORDER.map((tier) => {
          const group = models.filter((m) => m.tier === tier);
          if (group.length === 0) return null;
          return (
            <optgroup key={tier} label={TIER_LABEL[tier]}>
              {group.map((m) => {
                const snapshotNote = snapshotNoteFor(m.providerId, providerSnapshot);
                const healthNote =
                  snapshotNote ?? (m.health === 'DOWN' ? ' · down' : m.health === 'DEGRADED' ? ' · degraded' : '');
                const lockNote = m.locked ? ' · Pro' : '';
                const stateNote = stateNoteFor(m.providerId, providerState);
                const tagNote = capabilityTag(m) ? ` · ${capabilityTag(m)}` : '';
                const meta = `${CLASS_LABEL[m.computeClass]}${m.description ? ` — ${m.description}` : ''}`;
                return (
                  <option key={m.id} value={m.id} disabled={!usable(m)} title={`${meta}${healthNote}${stateNote}${tagNote ? ` · ${tagNote}` : ''}`}>
                    {m.label} ({m.providerId}){healthNote}
                    {lockNote}
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