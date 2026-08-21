/**
 * CodeConClave — ModelPicker: single dropdown in the chat composer.
 * Reads the AI registry (GET /api/v1/ai/models) and stores the choice.
 * Models are grouped by tier (PREMIUM / CAPABLE / EFFICIENT); locked
 * (entitlement) and DOWN providers are disabled, never selected silently.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AiModel } from '../lib/types';

const TIER_ORDER: AiModel['tier'][] = ['PREMIUM', 'CAPABLE', 'EFFICIENT'];
const TIER_LABEL: Record<AiModel['tier'], string> = {
  PREMIUM: 'Premium — complex work',
  CAPABLE: 'Capable — normal coding',
  EFFICIENT: 'Efficient — simple tasks',
};

function usable(m: AiModel): boolean {
  return m.available && m.health !== 'DOWN' && !m.locked;
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

  useEffect(() => {
    let active = true;
    void api<{ models: AiModel[]; defaultModel: string | null }>('/api/v1/ai/models')
      .then((res) => {
        if (!active) return;
        const list = res.models ?? [];
        setModels(list);
        setDefaultModel(res.defaultModel ?? undefined);
        const current = list.find((m) => m.id === value);
        const fallback = list.find(usable);
        if (!current || !usable(current)) {
          onChange(fallback ? fallback.id : (res.defaultModel ?? ''));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const chosen = value ?? defaultModel;

  return (
    <select
      className="cc-select"
      style={{ width: 260 }}
      value={chosen ?? ''}
      aria-label="Model"
      onChange={(e) => onChange(e.target.value)}
    >
      {models.length === 0 && <option value="">model…</option>}
      {TIER_ORDER.map((tier) => {
        const group = models.filter((m) => m.tier === tier);
        if (group.length === 0) return null;
        return (
          <optgroup key={tier} label={TIER_LABEL[tier]}>
            {group.map((m) => {
              const healthNote = m.health === 'DOWN' ? ' (down)' : m.health === 'DEGRADED' ? ' (degraded)' : '';
              const lockNote = m.locked ? ' (Pro)' : '';
              return (
                <option key={m.id} value={m.id} disabled={!usable(m)}>
                  {m.label} ({m.providerId})
                  {healthNote}
                  {lockNote}
                </option>
              );
            })}
          </optgroup>
        );
      })}
    </select>
  );
}