/**
 * CodeConClave — Lightweight AI Companion.
 * A tiny original presence: orb/capsule form with expressive eyes.
 * States: idle, thinking, working, waiting, approval, done, error.
 *
 * The state prop must always reflect REAL application state (stream phase,
 * task state) — never animate thinking/working unless work is happening.
 * Motion is CSS-only (no rAF loop, no per-frame style writes) so the
 * companion has no persistent JS cost. Respects prefers-reduced-motion and
 * pauses blinking while the tab is hidden.
 */
import { useEffect, useState } from 'react';

export type CompanionState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'approval'
  | 'done'
  | 'error';

interface AICompanionProps {
  state: CompanionState;
  className?: string;
  /** Accessible label override; defaults to a state-derived description. */
  'aria-label'?: string;
}

const BLINK_INTERVAL_MS = 4200;
const BLINK_DURATION_MS = 160;

const STATE_TEXT: Record<CompanionState, string> = {
  idle: 'AI companion idle',
  thinking: 'AI is thinking',
  working: 'AI is working',
  waiting: 'AI is waiting for input',
  approval: 'AI is waiting for approval',
  done: 'AI completed the task',
  error: 'AI encountered an error',
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

export function AICompanion({ state = 'idle', className = '', 'aria-label': ariaLabel }: AICompanionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [blink, setBlink] = useState(false);

  /* Natural blinking. Fully cleaned up; paused while the tab is hidden. */
  useEffect(() => {
    if (prefersReducedMotion) return;
    let blinkTimeout: number | null = null;
    let scheduleTimeout: number | null = null;
    let disposed = false;
    const scheduleBlink = () => {
      if (disposed || document.visibilityState === 'hidden') {
        scheduleTimeout = window.setTimeout(scheduleBlink, BLINK_INTERVAL_MS);
        return;
      }
      setBlink(true);
      blinkTimeout = window.setTimeout(() => setBlink(false), BLINK_DURATION_MS);
      scheduleTimeout = window.setTimeout(scheduleBlink, BLINK_INTERVAL_MS + Math.random() * 2000);
    };
    scheduleTimeout = window.setTimeout(scheduleBlink, BLINK_INTERVAL_MS);
    return () => {
      disposed = true;
      if (blinkTimeout !== null) window.clearTimeout(blinkTimeout);
      if (scheduleTimeout !== null) window.clearTimeout(scheduleTimeout);
    };
  }, [prefersReducedMotion]);

  const text = STATE_TEXT[state];

  /* Eyes: shape/color reinforce state so color is never the only signal.
     Approval + error use an alert (!-like) narrowing; done uses a
     downward "content" curve via border-radius. */
  const eyeBase: React.CSSProperties = {
    width: 6,
    height: blink ? 1.5 : 6,
    borderRadius: blink ? 1 : '50%',
    background: '#000',
    flexShrink: 0,
    transition: 'height 120ms ease, border-radius 120ms ease, background 120ms ease',
  };
  const eye: React.CSSProperties =
    state === 'approval' || state === 'error'
      ? { ...eyeBase, background: '#dc2626', width: 5, height: blink ? 1.5 : 7, borderRadius: blink ? 1 : 3 }
      : state === 'done'
        ? { ...eyeBase, background: '#16a34a' }
        : state === 'thinking' || state === 'working'
          ? { ...eyeBase, width: 5, height: blink ? 1.5 : 5 }
          : eyeBase;

  const motionClass = prefersReducedMotion ? 'cc-ai-companion--static' : `cc-ai-companion--${state}`;

  return (
    <div
      className={`cc-ai-companion ${motionClass}${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel ?? text}
      title={text}
      data-state={state}
    >
      <div className="cc-ai-companion__eyes" aria-hidden="true">
        <span style={eye} />
        <span style={eye} />
      </div>
      <span className="cc-sr-only">{text}</span>
    </div>
  );
}
