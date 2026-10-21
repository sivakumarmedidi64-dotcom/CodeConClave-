/**
 * Chat / Cowork (/ Agent) — one segmented switch, Claude-style: icon + label,
 * a highlight that slides to the selected mode, arrow keys move between modes.
 * Buttons keep aria-pressed so the switch reads as a toggle group.
 */
import { useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';

export interface ModeOption<T extends string> {
  value: T;
  label: string;
  icon: IconName;
  /** One line shown as the tooltip and under the switch when selected. */
  hint: string;
}

export function ModeSwitch<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  showHint = false,
}: {
  value: T;
  options: ModeOption<T>[];
  onChange: (next: T) => void;
  label: string;
  testId?: string;
  showHint?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (index + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div className="cc-modeswitch-wrap">
      <div
        className="cc-modeswitch"
        role="group"
        aria-label={label}
        data-testid={testId}
        onKeyDown={onKey}
        style={{ ['--cc-ms-n' as string]: options.length, ['--cc-ms-i' as string]: index }}
      >
        <span className="cc-modeswitch__thumb" aria-hidden="true" />
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className={o.value === value ? 'on' : ''}
            aria-pressed={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            title={o.hint}
            onClick={() => onChange(o.value)}
          >
            <Icon name={o.icon} size={14} />
            {o.label}
          </button>
        ))}
      </div>
      {showHint && <p className="cc-modeswitch__hint">{options[index]?.hint}</p>}
    </div>
  );
}

export const CHAT_MODE: ModeOption<'CHAT'> = { value: 'CHAT', label: 'Chat', icon: 'chat', hint: 'Quick answers, writing and images — one conversation with CodeConClave AI.' };
export const COWORK_MODE: ModeOption<'COWORK'> = {
  value: 'COWORK',
  label: 'Cowork',
  icon: 'users',
  hint: 'A planned task: the specialist team (planner, coder, reviewer, tester…) works it through the pipeline.',
};
export const AGENT_MODE: ModeOption<'AGENT'> = { value: 'AGENT', label: 'Agent', icon: 'terminal', hint: 'Works on this computer through the Local Agent: files, terminal and browser.' };
