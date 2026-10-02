/**
 * CodeConClave — intent routing (deterministic + lightweight classification).
 * Fast path vs Deep Work path. Never invokes a model for classification.
 */
const DEEP_WORK_MARKERS = [
  'refactor',
  'design the architecture',
  'architecture',
  'implement',
  'build a full',
  'security review',
  'perform security',
  'set up',
  'migrate',
  'multi-file',
  'pipeline',
  'rewrite the',
  'from scratch',
  'arhitecture',
];

const DEEP_WORK_RE = /(refactor|implement|architecture|architect|design and|security review|vulnerability assessment|set up|migrate the|rewrite|build a|create a system|plan and)/i;

export function triageIntent(content: string): 'fast' | 'deep' {
  const trimmed = content.trim();
  if (trimmed.length < 8) return 'fast';
  if (DEEP_WORK_RE.test(trimmed)) return 'deep';
  for (const marker of DEEP_WORK_MARKERS) {
    if (trimmed.toLowerCase().includes(marker)) return 'deep';
  }
  return 'fast';
}