/**
 * One copy control for the whole app: icon (or icon + label) button that
 * shows a check and "Copied" for a moment, announces it to screen readers,
 * and says so honestly when the clipboard refused.
 */
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { Icon } from './Icon';

export function CopyButton({
  text,
  label = 'Copy',
  showLabel = false,
  size = 14,
  className = '',
}: {
  /** The text, or a function that builds it at click time. */
  text: string | (() => string);
  label?: string;
  showLabel?: boolean;
  size?: number;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <button
      type="button"
      className={`cc-copy-btn${state === 'copied' ? ' is-copied' : ''}${showLabel ? ' has-label' : ''} ${className}`.trim()}
      onClick={() => void onClick()}
      aria-label={shown}
      title={shown}
    >
      <Icon name={state === 'copied' ? 'copy-check' : 'copy'} size={size} />
      {showLabel && <span>{shown}</span>}
      <span className="cc-sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}
