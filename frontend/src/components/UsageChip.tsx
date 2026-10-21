/** Live session usage under the composer, one click from Settings → Usage. */
import { Link } from 'react-router-dom';
import { sessionLabel, usePlanLimits } from '../lib/usage';

/** Re-checks every 30s and right after each reply (USAGE_CHANGED). */
export function UsageChip() {
  const { limits } = usePlanLimits();
  if (!limits) return null;
  const s = limits.session;
  const capped = s.limit > 0;
  const warn = limits.limited || (capped && s.pct >= 80);
  let text: string;
  if (limits.plan === 'none') text = 'No plan · choose Solo, Team or API Access';
  else if (limits.limited) text = `Usage limit reached · ${sessionLabel(s).toLowerCase()}`;
  else if (!capped) text = `${limits.planLabel} · unlimited`;
  else if (s.active === false || !s.resetsAt) text = `${limits.planLabel} · session starts with your first message`;
  else text = `Session ${s.pct}% used · ${sessionLabel(s).toLowerCase()}`;
  return (
    <Link
      to="/settings?tab=usage"
      className={`cc-usage-chip${warn ? ' is-warn' : ''}`}
      title="Your usage — open Settings → Usage"
      data-testid="usage-chip"
    >
      {text}
    </Link>
  );
}
