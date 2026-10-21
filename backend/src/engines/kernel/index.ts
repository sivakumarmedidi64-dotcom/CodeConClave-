/**
 * Scientific Verification Kernel — pure software on standard silicon.
 *
 * A specialist's answer carries machine-checkable claims in a fenced block:
 *
 *   ```claims
 *   [{ "kind": "identity", "lhs": "(x+1)^2", "rhs": "x^2+2x+1" }]
 *   ```
 *
 * runKernel re-derives every claim deterministically (seeded where random)
 * and returns proofs, each hashed; the proof hashes roll up into the receipt.
 * Claims are evidence to check, never instructions to follow.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../modules/audit/chain.js';
import { verifyDerivative, verifyIdentity, verifyIntegral, verifyNumeric } from './cas.js';
import { verifyUnits } from './units.js';
import { holm, verifyStats, type StatsClaim } from './stats.js';
import { simulate, type CircuitClaim } from './quantum.js';
import { verifyReactor, type ReactorClaim } from './nuclear.js';
import { seedFrom } from './rng.js';

export const KERNEL_VERSION = 'kernel-1.0.0';

export type Verifier = 'cas' | 'units' | 'stats' | 'quantum' | 'reactor';
export type ClaimKind = 'identity' | 'derivative' | 'integral' | 'numeric' | 'units' | 'stats' | 'circuit' | 'reactor';

export const VERIFIER_FOR: Record<ClaimKind, Verifier> = {
  identity: 'cas',
  derivative: 'cas',
  integral: 'cas',
  numeric: 'cas',
  units: 'units',
  stats: 'stats',
  circuit: 'quantum',
  reactor: 'reactor',
};

export interface Claim {
  kind: ClaimKind;
  [key: string]: unknown;
}

export interface Proof {
  index: number;
  kind: ClaimKind;
  verifier: Verifier;
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  method: string;
  detail: string;
  seed: number;
  inputHash: string;
  outputs: Record<string, unknown>;
  proofHash: string;
}

export interface KernelResult {
  version: string;
  proofs: Proof[];
  passed: number;
  failed: number;
  errors: number;
  /** sha256 over all proof hashes in order (null when there were no claims). */
  rollupHash: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_CLAIMS = 24;
const MAX_BLOCK = 64 * 1024;

/** Pull ```claims blocks out of an answer. Returns the answer without them. */
export function extractClaims(text: string): { claims: Claim[]; errors: string[]; text: string } {
  const claims: Claim[] = [];
  const errors: string[] = [];
  const stripped = text.replace(/```claims\s*\n([\s\S]*?)```/g, (_m, body: string) => {
    if (body.length > MAX_BLOCK) {
      errors.push('claims block too large');
      return '';
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of list) {
        if (c && typeof c === 'object' && typeof (c as Claim).kind === 'string' && (c as Claim).kind in VERIFIER_FOR) claims.push(c as Claim);
        else errors.push(`unknown claim: ${JSON.stringify(c).slice(0, 80)}`);
      }
    } catch (err) {
      errors.push(`claims block is not valid JSON: ${(err as Error).message}`);
    }
    return '';
  });
  if (claims.length > MAX_CLAIMS) {
    errors.push(`only the first ${MAX_CLAIMS} claims are checked`);
    claims.length = MAX_CLAIMS;
  }
  return { claims, errors, text: stripped.replace(/\n{3,}/g, '\n\n').trim() };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function checkOne(c: Claim, seed: number, adjustedP?: number): Omit<Proof, 'index' | 'inputHash' | 'proofHash' | 'seed'> {
  const verifier = VERIFIER_FOR[c.kind];
  switch (c.kind) {
    case 'identity': {
      const r = verifyIdentity(str(c.lhs), str(c.rhs), seed);
      return { kind: c.kind, verifier, verdict: r.verdict, method: r.method, detail: r.detail, outputs: { symbolic: r.symbolic, residual: r.residual ?? null, numeric: r.numeric } };
    }
    case 'derivative': {
      const r = verifyDerivative(str(c.f), str(c.var) || 'x', str(c.equals), seed);
      return { kind: c.kind, verifier, verdict: r.verdict, method: r.method, detail: r.detail, outputs: { derived: r.derived ?? null, symbolic: r.symbolic, numeric: r.numeric } };
    }
    case 'integral': {
      const r = verifyIntegral(str(c.f), str(c.var) || 'x', str(c.antiderivative), seed);
      return { kind: c.kind, verifier, verdict: r.verdict, method: `d/d${str(c.var) || 'x'} of antiderivative · ${r.method}`, detail: r.detail, outputs: { symbolic: r.symbolic, numeric: r.numeric } };
    }
    case 'numeric': {
      const r = verifyNumeric(str(c.expr), Number(c.value), typeof c.tol === 'number' ? c.tol : 1e-9);
      return { kind: c.kind, verifier, verdict: r.verdict, method: 'evaluate', detail: r.detail, outputs: { actual: r.actual ?? null } };
    }
    case 'units': {
      const r = verifyUnits(str(c.lhs), str(c.rhs), (c.symbols as Record<string, string>) ?? {});
      return { kind: c.kind, verifier, verdict: r.verdict, method: 'dimensional analysis (SI)', detail: r.detail, outputs: { lhs: r.lhs ?? null, rhs: r.rhs ?? null } };
    }
    case 'stats': {
      const r = verifyStats(c as unknown as StatsClaim, adjustedP);
      return { kind: c.kind, verifier, verdict: r.verdict, method: `${String((c.plan as { test?: string })?.test ?? '?')} · plan hashed first`, detail: r.detail, outputs: { planHash: r.planHash, ...r.outputs } };
    }
    case 'circuit': {
      const r = simulate(c as unknown as CircuitClaim, seed);
      return { kind: c.kind, verifier, verdict: r.verdict, method: 'state-vector simulation', detail: r.detail, outputs: { probs: r.probs, maxUnitarityError: r.maxUnitarityError, maxNormError: r.maxNormError, ...(r.counts ? { counts: r.counts } : {}) } };
    }
    case 'reactor': {
      const r = verifyReactor(c as unknown as ReactorClaim);
      return { kind: c.kind, verifier, verdict: r.verdict, method: `civil reactor physics · ${String(c.model)}`, detail: r.detail, outputs: r.outputs };
    }
  }
}

/**
 * Verify claims. `runSeed` (e.g. the run id) makes every seeded check
 * reproducible: claim i is checked with seedFrom(runSeed + ':' + i).
 */
export function runKernel(claims: Claim[], runSeed: string): KernelResult {
  // Stats tests in one run share a Holm correction when any asks for it.
  const statsIdx = claims.map((c, i) => (c.kind === 'stats' ? i : -1)).filter((i) => i >= 0);
  const wantsHolm = statsIdx.some((i) => (claims[i]!.plan as { correction?: string } | undefined)?.correction === 'holm');
  const adjusted = new Map<number, number>();
  if (wantsHolm && statsIdx.length > 1) {
    const raw = statsIdx.map((i) => verifyStats(claims[i] as unknown as StatsClaim).outputs.p as number | undefined);
    if (raw.every((p) => typeof p === 'number')) holm(raw as number[]).forEach((p, k) => adjusted.set(statsIdx[k]!, p));
  }

  const proofs: Proof[] = claims.map((c, index) => {
    const seed = seedFrom(`${runSeed}:${index}`);
    const inputHash = sha(canonicalJson(c));
    let core: Omit<Proof, 'index' | 'inputHash' | 'proofHash' | 'seed'>;
    try {
      core = checkOne(c, seed, adjusted.get(index));
    } catch (err) {
      core = { kind: c.kind, verifier: VERIFIER_FOR[c.kind], verdict: 'ERROR', method: 'n/a', detail: (err as Error).message, outputs: {} };
    }
    const proofHash = sha(canonicalJson({ v: KERNEL_VERSION, kind: core.kind, inputHash, seed, verdict: core.verdict, outputs: core.outputs }));
    return { index, ...core, seed, inputHash, proofHash };
  });

  return {
    version: KERNEL_VERSION,
    proofs,
    passed: proofs.filter((p) => p.verdict === 'PASS').length,
    failed: proofs.filter((p) => p.verdict === 'FAIL').length,
    errors: proofs.filter((p) => p.verdict === 'ERROR').length,
    rollupHash: proofs.length ? sha(proofs.map((p) => p.proofHash).join('|')) : null,
  };
}
