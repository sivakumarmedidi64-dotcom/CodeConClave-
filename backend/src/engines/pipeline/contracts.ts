/**
 * Specialist registry — 13 roles, 1 active per task. A role IS a contract:
 * the resident driver slot it runs on (5 tuned models, 0 extra weights), the
 * tools it may use, the verifiers its answers must pass, and its domain
 * scope. Contracts are versioned by content hash: editing one makes a new
 * version, and old receipts keep pointing at the version they ran under.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../modules/audit/chain.js';
import { driverForRole } from '../../modules/ingest/drivers.js';
import type { ClaimKind } from '../kernel/index.js';

export type Lane = 'code' | 'review' | 'design' | 'ops' | 'docs' | 'science';

export interface RoleContract {
  role: string;
  lane: Lane;
  /** Science roles run under domain verifiers; their answers MUST carry claims. */
  science: boolean;
  /** Claim kinds the kernel will accept from this role. */
  claimKinds: ClaimKind[];
  /** Tools this role may request (Act still asks approval for writes/sends/deploys). */
  tools: string[];
  /** What this role does — joined to the system prompt. */
  brief: string;
}

const CODE_TOOLS = ['read_files', 'propose_diff', 'run_tests'];
const ALL_CAS: ClaimKind[] = ['identity', 'derivative', 'integral', 'numeric'];

export const ROLE_CONTRACTS: RoleContract[] = [
  { role: 'Architect', lane: 'design', science: false, claimKinds: ['numeric', 'units'], tools: ['read_files'], brief: 'Design systems and plans: components, data flow, trade-offs, risks, and a step-by-step plan.' },
  { role: 'Coder', lane: 'code', science: false, claimKinds: ALL_CAS, tools: CODE_TOOLS, brief: 'Write correct, idiomatic code that matches the project. Show complete, runnable snippets.' },
  { role: 'Debugger', lane: 'code', science: false, claimKinds: ALL_CAS, tools: CODE_TOOLS, brief: 'Find the root cause from the evidence, explain it, and give the smallest safe fix.' },
  { role: 'Reviewer', lane: 'review', science: false, claimKinds: [], tools: ['read_files'], brief: 'Review for correctness, readability and maintainability. List findings by severity with file/line and a fix.' },
  { role: 'Tester', lane: 'code', science: false, claimKinds: [], tools: CODE_TOOLS, brief: 'Write focused tests that pin real behaviour, including failure paths and edge cases.' },
  { role: 'Security', lane: 'review', science: false, claimKinds: [], tools: ['read_files'], brief: 'Defensive security review: injection, auth, secrets, data exposure, unsafe defaults. Give fixes, never exploit steps.' },
  { role: 'DevOps', lane: 'ops', science: false, claimKinds: ['numeric'], tools: ['read_files', 'propose_diff'], brief: 'Build, CI, deploy and runtime configuration with safe, reversible steps.' },
  { role: 'UI/UX', lane: 'design', science: false, claimKinds: [], tools: ['read_files', 'propose_diff'], brief: 'Interface and interaction design: layout, accessibility, states, copy.' },
  { role: 'Documentation', lane: 'docs', science: false, claimKinds: ['numeric'], tools: ['read_files'], brief: 'Explain clearly and accurately for the reader; answer general questions directly.' },
  { role: 'Quantum Physics', lane: 'science', science: true, claimKinds: ['circuit', 'identity', 'numeric', 'units'], tools: [], brief: 'Quantum mechanics and quantum computing. Check unitarity, normalization and units; prefer explicit circuits and state vectors.' },
  { role: 'Nuclear Physics', lane: 'science', science: true, claimKinds: ['reactor', 'numeric', 'units', 'identity'], tools: [], brief: 'Civil nuclear science and engineering only: reactor physics, decay, shielding, medical and power applications.' },
  { role: 'Computational Math', lane: 'science', science: true, claimKinds: ALL_CAS, tools: [], brief: 'Exact mathematics: algebra, calculus, identities. Every result must be checkable symbolically or at seeded points.' },
  { role: 'Statistics', lane: 'science', science: true, claimKinds: ['stats', 'numeric'], tools: [], brief: 'Statistical analysis: state the plan (test, alpha, correction) first, then report CI, effect size and multiplicity-corrected p-values.' },
];

const BY_ROLE = new Map(ROLE_CONTRACTS.map((c) => [c.role, c]));

export function contractFor(role: string): RoleContract | undefined {
  return BY_ROLE.get(role);
}

/** "computational-math@3f9a1c2b7d10" — changes whenever the contract changes. */
export function contractVersion(c: RoleContract): string {
  const slug = c.role.toLowerCase().replace(/[^a-z]+/g, '-');
  return `${slug}@${createHash('sha256').update(canonicalJson(c)).digest('hex').slice(0, 12)}`;
}

/** The resident driver slot a role is bound to (5 drivers serve all 13 roles). */
export function driverSlot(role: string): string {
  return driverForRole(role)?.hubId ?? 'unbound';
}

const CLAIMS_HOWTO: Record<string, string> = {
  identity: '{"kind":"identity","lhs":"(x+1)^2","rhs":"x^2+2x+1"}',
  derivative: '{"kind":"derivative","f":"x^3","var":"x","equals":"3x^2"}',
  integral: '{"kind":"integral","f":"2x","var":"x","antiderivative":"x^2"}',
  numeric: '{"kind":"numeric","expr":"sqrt(2)","value":1.41421356,"tol":1e-6}',
  units: '{"kind":"units","lhs":"m*a","rhs":"F","symbols":{"m":"kg","a":"m/s^2","F":"N"}}',
  stats: '{"kind":"stats","plan":{"test":"welch_t","alpha":0.05,"correction":"holm"},"data":{"a":[...],"b":[...]},"expect":{"p_lt":0.05}}',
  circuit: '{"kind":"circuit","qubits":2,"gates":[["H",0],["CNOT",0,1]],"expect":{"probs":{"00":0.5,"11":0.5}}}',
  reactor: '{"kind":"reactor","model":"bare_one_group","geometry":"sphere","params":{"nuSigmaF":0.0175,"sigmaA":0.015,"D":1,"R":62.83},"expect":{"k_eff":1}}',
};

/** The role's system instructions, including how to state checkable claims. */
export function roleSystemPrompt(c: RoleContract): string {
  const lines = [`You are acting as CodeConClave's ${c.role} specialist. ${c.brief}`];
  if (c.claimKinds.length) {
    lines.push(
      c.science
        ? 'Your answer is checked by the Scientific Verification Kernel. You MUST end it with a fenced ```claims block holding a JSON array of the key results, in these forms:'
        : 'If your answer contains math or numeric results, end it with a fenced ```claims block (JSON array) so they can be verified, in these forms:',
    );
    for (const k of c.claimKinds) lines.push(`- ${CLAIMS_HOWTO[k]}`);
    lines.push('Write products between variables explicitly (2*x*y — "xy" is ONE variable named xy); a number may touch a variable (2x).');
    lines.push('Only claim what you are sure of; every claim is re-derived and a false claim fails the answer.');
  }
  return lines.join('\n');
}
