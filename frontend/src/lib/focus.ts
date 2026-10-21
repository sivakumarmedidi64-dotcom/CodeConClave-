/**
 * Focus Morph (Beyond agentic #8, from "intent-driven UI morphing"). The Home
 * composer reads what you are typing and morphs to fit: a focus colour, and
 * the right CodeConClave tools one click away (security → threat model and an
 * independent review; a bug → the evidence-first bug fix; data → a chart…).
 * Deterministic keyword rules, in the browser, nothing sent anywhere.
 */
export type FocusId = 'security' | 'debug' | 'data' | 'design' | 'writing' | 'planning';

export interface Focus {
  id: FocusId;
  label: string;
  icon: 'shield' | 'bug' | 'chart' | 'palette' | 'edit' | 'map';
  actions: { label: string; insert: string }[];
}

const RULES: { id: FocusId; re: RegExp; focus: Omit<Focus, 'id'> }[] = [
  {
    id: 'security',
    re: /\b(auth\w*|login|log ?in|passwords?|tokens?|jwt|oauth|secrets?|xss|csrf|sql injection|vulnerab\w*|encrypt\w*|permissions?|security|exploit)\b/i,
    focus: { label: 'Security focus', icon: 'shield', actions: [{ label: 'Threat model', insert: '/threat-model ' }, { label: 'Independent review', insert: '/second-review ' }] },
  },
  {
    id: 'debug',
    re: /\b(bugs?|errors?|exceptions?|crash\w*|stack ?trace|traceback|fails?|failing|broken|not working|undefined is not|null pointer)\b/i,
    focus: { label: 'Debugging focus', icon: 'bug', actions: [{ label: 'Evidence-first fix', insert: '/bugfix ' }, { label: 'Debug', insert: '/debug ' }] },
  },
  {
    id: 'data',
    re: /\b(csv|sql|quer(y|ies)|dataset|charts?|graphs?|analy[sz]e|metrics|dashboards?|excel|spreadsheet)\b/i,
    focus: { label: 'Data focus', icon: 'chart', actions: [{ label: 'Make a chart', insert: 'Make a chart of ' }, { label: 'Explain a query', insert: '/explain-query ' }] },
  },
  {
    id: 'design',
    re: /\b(ui|ux|design|layout|css|colou?rs?|fonts?|landing page|figma|components?|responsive)\b/i,
    focus: { label: 'Design focus', icon: 'palette', actions: [{ label: 'Build it as a page', insert: 'Build this as a single HTML page with a live preview: ' }] },
  },
  {
    id: 'writing',
    re: /\b(emails?|letters?|blog|posts?|essays?|copy ?writing|rewrite|proofread|summari[sz]e|tweet|caption)\b/i,
    focus: { label: 'Writing focus', icon: 'edit', actions: [{ label: 'Draft an email', insert: 'Draft an email to ' }] },
  },
  {
    id: 'planning',
    re: /\b(plans?|roadmaps?|milestones?|schedules?|timelines?|launch|strategy|sprints?)\b/i,
    focus: { label: 'Planning focus', icon: 'map', actions: [{ label: 'Plan it', insert: '/plan ' }, { label: 'Milestones', insert: '/milestones ' }] },
  },
];

/** The focus for what is being typed, or null. Pure. */
export function detectFocus(text: string): Focus | null {
  const t = text.trim();
  if (t.length < 6 || t.startsWith('/')) return null;
  for (const r of RULES) if (r.re.test(t)) return { id: r.id, ...r.focus };
  return null;
}
