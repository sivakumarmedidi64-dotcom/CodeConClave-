/**
 * Cowork team picker: tap bots to put them on your task. None selected =
 * Auto (the planner chooses the team). The pick is sent as the task's
 * coworker pipeline, in the order shown.
 */
import { Bot, PICKABLE_BOTS, personaFor } from './Bot';

export function TeamPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (kind: string) =>
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : PICKABLE_BOTS.filter((k) => k === kind || value.includes(k)));
  return (
    <div className="cc-teampick" role="group" aria-label="Choose your bot team" data-testid="team-picker">
      <span className="cc-teampick__label">
        <span>{value.length === 0 ? 'Team: Auto — the planner picks who works on it' : `Team: ${value.length} bot${value.length === 1 ? '' : 's'}`}</span>
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])}>
            Reset to Auto
          </button>
        )}
      </span>
      {PICKABLE_BOTS.map((kind) => {
        const p = personaFor(kind);
        const on = value.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            className="cc-teampick__bot"
            aria-pressed={on}
            aria-label={`${on ? 'Remove' : 'Add'} ${p.name} the ${p.role}`}
            title={`${p.name} · ${p.role}`}
            onClick={() => toggle(kind)}
          >
            <Bot kind={kind} state={on ? 'idle' : 'waiting'} size={36} />
          </button>
        );
      })}
    </div>
  );
}
