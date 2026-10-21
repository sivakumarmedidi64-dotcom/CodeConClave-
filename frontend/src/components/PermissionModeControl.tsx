/**
 * Permission mode (Claude-style): how often agent actions on your paired
 * computer stop to ask. Server-enforced via the policy engine; a mode never
 * allows anything the baseline denies, and deletes / high-risk commands
 * always ask.
 *
 * Power Mode: Auto-accept edits or Auto can be granted for a fixed time; the
 * server switches back to your previous mode when it ends.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { Icon, type IconName } from './Icon';

export type PermissionMode = 'ask' | 'accept_edits' | 'full_access';

export const PERMISSION_MODE_INFO: Record<PermissionMode, { label: string; short: string; icon: IconName; detail: string }> = {
  ask: {
    label: 'Manual',
    short: 'Manual',
    icon: 'shield',
    detail: 'Asks before every file edit and every non-trivial command.',
  },
  accept_edits: {
    label: 'Auto-accept edits',
    short: 'Accept edits',
    icon: 'edit',
    detail: 'File edits and new files inside granted folders apply without asking. Commands still ask.',
  },
  full_access: {
    label: 'Auto',
    short: 'Auto',
    icon: 'bolt',
    detail: 'Edits and medium-risk commands run without asking. Deletes and high-risk commands still ask.',
  },
};

const ORDER: PermissionMode[] = ['ask', 'accept_edits', 'full_access'];

/** Power Mode durations offered in the UI (minutes; null = until changed). */
export const POWER_DURATIONS: { label: string; minutes: number | null }[] = [
  { label: 'Until I change it', minutes: null },
  { label: 'For 30 minutes', minutes: 30 },
  { label: 'For 2 hours', minutes: 120 },
  { label: 'For 8 hours', minutes: 480 },
];

interface ModeState {
  mode: PermissionMode;
  expiresAt: string | null;
  revertTo: PermissionMode | null;
}

/** "1 hr 12 min left" / "4 min left". */
export function timeLeft(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  // Round to the nearest minute, but never show 0 while time remains.
  const mins = ms <= 0 ? 0 : Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min left`;
  return `${Math.floor(mins / 60)} hr ${mins % 60} min left`;
}

function usePermissionMode() {
  const { toast } = useToast();
  const [state, setState] = useState<ModeState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<Partial<ModeState>>('/api/v1/control/permission-mode')
      .then((res) =>
        setState({
          mode: res.mode && ORDER.includes(res.mode) ? res.mode : 'ask',
          expiresAt: res.expiresAt ?? null,
          revertTo: res.revertTo ?? null,
        }),
      )
      .catch(() => setState({ mode: 'ask', expiresAt: null, revertTo: null }));
  }, []);
  useEffect(load, [load]);

  // When a Power Mode grant ends, re-read: the server has already switched back.
  useEffect(() => {
    if (!state?.expiresAt) return;
    const ms = Date.parse(state.expiresAt) - Date.now();
    const t = window.setTimeout(load, Math.max(1000, ms + 1000));
    return () => window.clearTimeout(t);
  }, [state?.expiresAt, load]);

  const change = useCallback(
    async (next: PermissionMode, minutes: number | null = null) => {
      setSaving(true);
      try {
        const res = await api<Partial<ModeState>>('/api/v1/control/permission-mode', {
          method: 'PUT',
          body: minutes && next !== 'ask' ? { mode: next, minutes } : { mode: next },
        });
        const mode = res.mode && ORDER.includes(res.mode) ? res.mode : next;
        setState({ mode, expiresAt: res.expiresAt ?? null, revertTo: res.revertTo ?? null });
        toast(
          res.expiresAt
            ? `Power Mode: ${PERMISSION_MODE_INFO[mode].label} for ${timeLeft(res.expiresAt).replace(' left', '')}, then back to ${PERMISSION_MODE_INFO[res.revertTo ?? 'ask'].label}`
            : `Permission mode: ${PERMISSION_MODE_INFO[mode].label}`,
        );
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not change permission mode', 'error');
      } finally {
        setSaving(false);
      }
    },
    [toast],
  );

  return { state, mode: state?.mode ?? null, saving, change };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** Full card for the Control page. */
export function PermissionModeCard() {
  const { state, mode, saving, change } = usePermissionMode();
  const [minutes, setMinutes] = useState<number | null>(null);
  const now = useNow(Boolean(state?.expiresAt));
  return (
    <div className="cc-card pm-card" data-testid="permission-mode">
      <h3 style={{ margin: 0 }}>Permission mode</h3>
      <p className="cc-hint" style={{ margin: '4px 0 12px' }}>
        How often your coworker stops to ask before acting on your paired computer. Secret files, dangerous commands and
        folders you haven&apos;t granted stay blocked in every mode.
      </p>
      <div className="pm-options" role="radiogroup" aria-label="Permission mode">
        {ORDER.map((m) => {
          const info = PERMISSION_MODE_INFO[m];
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={saving || mode === null}
              className={`pm-option${mode === m ? ' is-active' : ''}`}
              onClick={() => void change(m, m === 'ask' ? null : minutes)}
            >
              <span className="pm-option-head">
                <Icon name={info.icon} size={16} className="sp-btn-icon" />
                <strong>{info.label}</strong>
              </span>
              <span className="pm-option-detail">{info.detail}</span>
            </button>
          );
        })}
      </div>
      <div className="pm-power">
        <Icon name="zap" size={14} />
        <label htmlFor="pm-duration">Power Mode — when you pick Auto-accept edits or Auto:</label>
        <select id="pm-duration" className="cc-select cc-select--sm" value={minutes ?? ''} onChange={(e) => setMinutes(e.target.value ? Number(e.target.value) : null)}>
          {POWER_DURATIONS.map((d) => (
            <option key={d.label} value={d.minutes ?? ''}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {state?.expiresAt && (
        <p className="pm-countdown" role="status" data-testid="power-countdown">
          <strong>{PERMISSION_MODE_INFO[state.mode].label}</strong> · {timeLeft(state.expiresAt, now)}, then back to{' '}
          {PERMISSION_MODE_INFO[state.revertTo ?? 'ask'].label}.
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" disabled={saving} onClick={() => void change(state.revertTo ?? 'ask')}>
            End now
          </button>
        </p>
      )}
    </div>
  );
}

/** Compact chip for the chat composer (Agent mode). */
export function PermissionModeChip() {
  const { state, mode, saving, change } = usePermissionMode();
  const now = useNow(Boolean(state?.expiresAt));
  if (mode === null) return null;
  return (
    <label
      className={`pm-chip pm-chip--${mode}`}
      title={state?.expiresAt ? `${PERMISSION_MODE_INFO[mode].detail} Power Mode: ${timeLeft(state.expiresAt, now)}.` : PERMISSION_MODE_INFO[mode].detail}
    >
      <Icon name={state?.expiresAt ? 'zap' : PERMISSION_MODE_INFO[mode].icon} size={13} className="sp-btn-icon" />
      <select aria-label="Permission mode" value={mode} disabled={saving} onChange={(e) => void change(e.target.value as PermissionMode)}>
        {ORDER.map((m) => (
          <option key={m} value={m}>
            {PERMISSION_MODE_INFO[m].short}
          </option>
        ))}
      </select>
      {state?.expiresAt && <span className="pm-chip__left">{timeLeft(state.expiresAt, now)}</span>}
    </label>
  );
}
