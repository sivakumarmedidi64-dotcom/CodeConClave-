/**
 * Effort (Claude-style): how much work goes into each answer. Low = fast and
 * brief, High = step-by-step and thorough with a larger answer budget.
 * Saved as a preference and sent with every message.
 */
import { savePrefs, usePref } from '../lib/prefs';

export type Effort = 'low' | 'medium' | 'high';

const LABEL: Record<Effort, string> = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' };

export function useEffort(): Effort {
  const v = usePref<string>('effort');
  return v === 'low' || v === 'high' ? v : 'medium';
}

export function EffortChip() {
  const effort = useEffort();
  return (
    <label className="cc-effort" title="How much work goes into each answer">
      <span className="cc-effort__bars" aria-hidden="true" data-level={effort}>
        <i />
        <i />
        <i />
      </span>
      <select aria-label="Effort" value={effort} onChange={(e) => void savePrefs({ effort: e.target.value })}>
        {(['low', 'medium', 'high'] as const).map((e) => (
          <option key={e} value={e}>
            {LABEL[e]}
          </option>
        ))}
      </select>
    </label>
  );
}
