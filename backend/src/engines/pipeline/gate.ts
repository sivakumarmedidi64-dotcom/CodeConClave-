/**
 * Gate · sentinel — deterministic, 0 tokens. Runs before any specialist:
 *   schema     request shape, size and role are valid
 *   ownership  the run is bound to a real user (and project/task when given)
 *   secrets    high-confidence secrets in the request are redacted before any
 *              model sees them (the user is told)
 *   risk       destructive commands are flagged — Act always asks approval
 *   domain     science roles stay in scope; weapon-relevant nuclear asks are
 *              denied for every role
 * A denial is a ledger event with an explanation, and is never retried.
 */
import { SECRET_PATTERNS } from '../../modules/secretGuard/patterns.js';
import { contractFor } from './contracts.js';

export interface GateInput {
  userId: string | null | undefined;
  projectId?: string | null;
  role: string;
  question: string;
}

export interface GateResult {
  allowed: boolean;
  /** The question after redaction (what the specialist sees). */
  question: string;
  checks: { check: string; ok: boolean; note?: string }[];
  denial?: { check: string; reason: string };
  redactions: number;
  riskyCommand: boolean;
}

const MAX_QUESTION = 32_000;

// Civil nuclear science is in scope; weapon design/production is not.
const WEAPON_PATTERNS: RegExp[] = [
  /\b(nuclear|atomic|thermonuclear|hydrogen|fission|fusion|dirty|radiological)\s+(bomb|weapon|warhead|device)s?\b/i,
  /\b(warheads?|implosion lens(es)?|explosive lens(es)?|neutron initiators?|boosted fission|weapons?[- ](grade|usable))\b/i,
  /\bcritical mass\b[^.\n]{0,40}\b(plutonium|pu-?239|u-?235|uranium|heu)\b/i,
  /\b(plutonium|pu-?239|u-?235|heu)\b[^.\n]{0,40}\bcritical mass\b/i,
  /\benrich\w*\b[^.\n]{0,40}\b(8[5-9]|9\d)\s*%/i,
  /\b(yield|detonat\w*)\b[^.\n]{0,40}\b(kilotons?|megatons?|kt|mt)\b/i,
  /\bhow (to|do i|can i|would you)\b[^.\n]{0,60}\b(make|build|design|assemble|construct)\b[^.\n]{0,40}\b(nuclear|atomic|radiological|dirty)\b/i,
];

const DESTRUCTIVE = /\b(rm\s+-rf\s+[/~]|mkfs(\.\w+)?\s|dd\s+if=|format\s+[a-z]:|drop\s+(database|table)\b|truncate\s+table\b|del\s+\/[sq]\b|shutdown\s+(-h|\/s))/i;

export function isWeaponRelevant(text: string): boolean {
  return WEAPON_PATTERNS.some((re) => re.test(text));
}

export function runGate(input: GateInput): GateResult {
  const checks: GateResult['checks'] = [];
  const deny = (check: string, reason: string, question = input.question): GateResult => ({
    allowed: false,
    question,
    checks: [...checks, { check, ok: false, note: reason }],
    denial: { check, reason },
    redactions: 0,
    riskyCommand: false,
  });

  // schema
  if (typeof input.question !== 'string' || !input.question.trim()) return deny('schema', 'The request is empty.');
  if (input.question.length > MAX_QUESTION) return deny('schema', `The request is longer than ${MAX_QUESTION.toLocaleString()} characters.`);
  const contract = contractFor(input.role);
  if (!contract) return deny('schema', `Unknown role "${input.role}".`);
  checks.push({ check: 'schema', ok: true });

  // ownership
  if (!input.userId) return deny('ownership', 'The run is not bound to a signed-in user.');
  checks.push({ check: 'ownership', ok: true, note: input.projectId ? `project ${input.projectId}` : 'personal scope' });

  // domain scope (every role — a weapon ask routed elsewhere is still denied)
  if (isWeaponRelevant(input.question)) {
    return deny('domain', "Denied at the Gate: CodeConClave's nuclear science covers civil research and engineering only (reactors, decay, shielding, medical and power uses), not weapons.");
  }
  checks.push({ check: 'domain', ok: true, note: contract.science ? `${contract.role} scope` : undefined });

  // secrets — redact high-confidence matches only (never mangle ordinary hashes)
  let question = input.question;
  let redactions = 0;
  for (const p of SECRET_PATTERNS) {
    if (p.confidence < 0.9) continue;
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    question = question.replace(re, () => {
      redactions += 1;
      return `[REDACTED ${p.label}]`;
    });
  }
  checks.push({ check: 'secrets', ok: true, note: redactions ? `${redactions} secret(s) redacted before the model` : undefined });

  // risky command — flagged, not denied: chat never executes; Act asks approval.
  const riskyCommand = DESTRUCTIVE.test(question);
  checks.push({ check: 'risky_command', ok: true, note: riskyCommand ? 'destructive command mentioned — nothing runs without your approval' : undefined });

  return { allowed: true, question, checks, redactions, riskyCommand };
}
