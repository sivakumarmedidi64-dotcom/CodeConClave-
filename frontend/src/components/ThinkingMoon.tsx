/**
 * CodeConClave — AI Thinking Moon (Phase 12).
 * A small black crescent (<=80px), centered in the workspace, shown ONLY
 * while a real generation is in progress — never for idle state and never
 * after completion. Motion is subtle 3D: slow rotation, tilt, floating;
 * intensity drops once the response is streaming. Animations pause when the
 * tab is hidden (GPU/CSS only) and collapse to a simple fade under
 * prefers-reduced-motion. Screen-reader status via an aria-live region.
 */
import { useEffect, useState } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ThinkingMoon({
  active,
  streaming = false,
  label = 'CodeConClave is thinking',
}: {
  active: boolean;
  /** True once the first response delta has arrived → reduced intensity. */
  streaming?: boolean;
  label?: string;
}) {
  const [reduced] = useState(prefersReducedMotion);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'visible');

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (!active) return null;
  const classes = ['cc-moon--think'];
  if (reduced) classes.push('cc-moon--think--static');
  else if (streaming) classes.push('cc-moon--think--streaming');
  if (hidden) classes.push('cc-moon--think--paused');
  return (
    <div className="cc-thinking" role="status" aria-live="polite">
      <div className={classes.join(' ')} aria-hidden="true" />
      <span className="cc-sr-only">{label}</span>
    </div>
  );
}
