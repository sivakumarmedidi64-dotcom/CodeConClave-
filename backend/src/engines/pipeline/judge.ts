/**
 * Verify · judge — the contract gate. Blind: it sees only the answer's claims
 * and the kernel's proofs, never the specialist's reasoning.
 *   science role  needs ≥ 1 claim, every claim of an allowed kind, every
 *                 proof PASS → VERIFIED; otherwise REPAIR with the reasons.
 *   other roles   claims are optional; any claim present must PASS. No claims
 *                 → UNVERIFIED (said plainly, not treated as a failure).
 */
import type { Claim, KernelResult } from '../kernel/index.js';
import type { RoleContract } from './contracts.js';

export type Verdict = 'VERIFIED' | 'UNVERIFIED' | 'REPAIR';

export interface Judgement {
  verdict: Verdict;
  reasons: string[];
}

export function judge(contract: RoleContract, claims: Claim[], parseErrors: string[], kernel: KernelResult): Judgement {
  const reasons: string[] = [];
  for (const e of parseErrors) reasons.push(e);
  for (const c of claims) {
    if (!contract.claimKinds.includes(c.kind)) reasons.push(`"${c.kind}" claims are outside the ${contract.role} contract`);
  }
  for (const p of kernel.proofs) {
    if (p.verdict !== 'PASS') reasons.push(`claim ${p.index + 1} (${p.kind}) ${p.verdict === 'FAIL' ? 'failed' : 'could not be checked'}: ${p.detail}`);
  }
  if (contract.science && claims.length === 0) reasons.push('no machine-checkable claims — a science answer must end with a ```claims block');
  if (reasons.length) return { verdict: 'REPAIR', reasons };
  return { verdict: claims.length ? 'VERIFIED' : 'UNVERIFIED', reasons: [] };
}

/** The note handed to the specialist on a repair attempt. */
export function repairNote(attempt: number, reasons: string[]): string {
  return [
    `Your previous answer did not pass verification (repair attempt ${attempt} of 2). Fix exactly these problems and answer again in full:`,
    ...reasons.slice(0, 8).map((r) => `- ${r}`),
  ].join('\n');
}
