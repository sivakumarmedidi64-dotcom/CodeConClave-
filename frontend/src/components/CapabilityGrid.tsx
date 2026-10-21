/**
 * What CodeConClave can do — shown on an empty Home. Each card fills the
 * composer with a starter prompt. Wording stays inside what the product does
 * today (no claims a feature can't back).
 */
import { Icon, type IconName } from './Icon';

export interface Capability {
  title: string;
  detail: string;
  icon: IconName;
  prompt: string;
}

export const CAPABILITIES: Capability[] = [
  { title: 'Answers and research', detail: 'Explain topics, compare options, and work through sources you give it.', icon: 'search', prompt: 'Compare PostgreSQL and MongoDB for a small SaaS app — pros, cons and when to pick each.' },
  { title: 'Writing and editing', detail: 'Draft or revise emails, reports, proposals, plans and policies.', icon: 'edit', prompt: 'Draft a short, friendly email telling my team the launch moved to Friday.' },
  { title: 'Coding', detail: 'Explain, write, debug and review code; plan and build websites and apps.', icon: 'code', prompt: 'Write a TypeScript function that debounces another function, with a test.' },
  { title: 'Files and data', detail: 'Analyze CSVs and data, make charts, and create files you can download.', icon: 'chart', prompt: 'Make a bar chart of monthly signups: Jan 120, Feb 180, Mar 260, Apr 310.' },
  { title: 'Images and media', detail: 'Generate images, and talk or listen with voice.', icon: 'image', prompt: 'Draw an image of a gold robot coworker at a dark desk, cinematic lighting.' },
  { title: 'Business support', detail: 'Brainstorm ideas, prepare marketing copy and organize projects.', icon: 'bulb', prompt: 'Brainstorm 10 launch ideas for an AI coworker app in India.' },
  { title: 'Planning', detail: 'Schedules, checklists and step-by-step plans.', icon: 'clock', prompt: 'Make a 7-day checklist to ship a landing page, one task per day.' },
  { title: 'Verified science', detail: 'Math, statistics, quantum and reactor physics, checked by the verification kernel.', icon: 'shield-check', prompt: 'Prove the identity (a+b)^2 = a^2 + 2ab + b^2.' },
];

export function CapabilityGrid({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <section className="cc-capgrid" aria-label="What CodeConClave can do">
      {CAPABILITIES.map((c) => (
        <button key={c.title} type="button" className="cc-capcard" onClick={() => onPick(c.prompt)} title={c.prompt}>
          <Icon name={c.icon} size={16} />
          <strong>{c.title}</strong>
          <span>{c.detail}</span>
        </button>
      ))}
    </section>
  );
}

export function MistakesNote() {
  return (
    <p className="cc-mistakes" data-testid="mistakes-note">
      CodeConClave can make mistakes — check important answers. Anything that emails, publishes, deploys or pays always asks you first.
    </p>
  );
}
