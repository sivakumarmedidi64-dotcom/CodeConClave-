/**
 * Stop everything: the always-available panic control. One server call
 * cancels running tasks and laptop actions and holds all unattended work
 * (schedules, automations) until Resume. Lives in the top bar; the banner
 * makes the hold impossible to forget.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { useOptionalToast as useToast } from './Toast';

export const HOLD_CHANGED = 'cc:hold-changed';
export const STOP_EVERYTHING = 'cc:stop-everything';

interface Hold {
  held: boolean;
  heldSince: string | null;
  reason: string | null;
}

interface Stopped {
  assignmentsCancelled: number;
  assignmentsFailed: number;
  tasksCancelled: number;
  tasksSkipped: number;
}

export function useHold(): Hold | null {
  const [hold, setHold] = useState<Hold | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ hold: Hold }>('/api/v1/control/emergency-stop')
        .then((r) => alive && r?.hold && setHold(r.hold))
        .catch(() => undefined);
    void load();
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<Hold | undefined>).detail;
      if (next) setHold(next);
      else void load();
    };
    window.addEventListener(HOLD_CHANGED, onChange);
    return () => {
      alive = false;
      window.removeEventListener(HOLD_CHANGED, onChange);
    };
  }, []);
  return hold;
}

export function summarizeStop(s: Stopped): string {
  const parts = [`${s.tasksCancelled} task${s.tasksCancelled === 1 ? '' : 's'}`, `${s.assignmentsCancelled} laptop action${s.assignmentsCancelled === 1 ? '' : 's'}`];
  const extra = s.assignmentsFailed + s.tasksSkipped > 0 ? ` (${s.assignmentsFailed + s.tasksSkipped} already finishing or unreachable)` : '';
  return `Stopped ${parts.join(' and ')}${extra}. Scheduled and automated work is on hold until you resume.`;
}

export function useStopEverything() {
  const { toast } = useToast();
  return useCallback(async () => {
    try {
      const r = await api<{ stopped: Stopped; hold: Hold }>('/api/v1/control/emergency-stop', { method: 'POST', body: { reason: 'Stop everything' } });
      window.dispatchEvent(new CustomEvent(HOLD_CHANGED, { detail: r.hold }));
      toast(summarizeStop(r.stopped));
    } catch (err) {
      toast(err instanceof Error ? `Could not stop: ${err.message}` : 'Could not stop — try again', 'error');
    }
  }, [toast]);
}

export function EmergencyStopButton() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const stopEverything = useStopEverything();
  const go = async () => {
    setBusy(true);
    await stopEverything();
    setBusy(false);
    setConfirming(false);
  };
  // Keyboard path (Ctrl/Cmd+Shift+.) is deliberate, so it skips the confirm.
  useEffect(() => {
    const onStop = () => void go();
    window.addEventListener(STOP_EVERYTHING, onStop);
    return () => window.removeEventListener(STOP_EVERYTHING, onStop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="cc-stop-btn"
        onClick={() => setConfirming((v) => !v)}
        aria-label="Stop everything"
        aria-expanded={confirming}
        title="Stop everything (Ctrl+Shift+.)"
      >
        <Icon name="stop-circle" size={17} />
      </button>
      {confirming && (
        <div className="cc-popover cc-stop-pop" role="dialog" aria-label="Stop everything">
          <strong>Stop everything?</strong>
          <p className="cc-hint">Cancels running tasks and laptop actions, and holds scheduled and automated work until you resume. Nothing is deleted.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="cc-btn cc-btn--danger cc-btn--sm" autoFocus disabled={busy} onClick={() => void go()}>
              {busy ? 'Stopping…' : 'Stop everything'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HoldBanner() {
  const hold = useHold();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  if (!hold?.held) return null;
  const resume = async () => {
    setBusy(true);
    try {
      const r = await api<{ hold: Hold }>('/api/v1/control/emergency-stop', { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent(HOLD_CHANGED, { detail: r.hold }));
      toast('Resumed — scheduled and automated work can run again.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not resume', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cc-hold-banner" role="status" data-testid="hold-banner">
      <Icon name="stop-circle" size={16} />
      <span>
        <strong>Everything is stopped.</strong> No scheduled or automated work will start
        {hold.heldSince ? ` (since ${new Date(hold.heldSince).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.
      </span>
      <button type="button" className="cc-btn cc-btn--sm" disabled={busy} onClick={() => void resume()}>
        {busy ? 'Resuming…' : 'Resume'}
      </button>
    </div>
  );
}
