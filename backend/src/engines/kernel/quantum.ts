/**
 * Quantum Physics verifier: an exact state-vector simulator (≤ 12 qubits).
 * Every gate is checked for unitarity (U†U = I) before it is applied, and the
 * state's normalization is checked after every step. Bitstrings read qubit 0
 * as the LEFTMOST character ("10" = qubit 0 is |1⟩, qubit 1 is |0⟩).
 */
import { mulberry32 } from './rng.js';

export type C = [number, number]; // [re, im]
type M2 = [[C, C], [C, C]];

const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const conj = (a: C): C => [a[0], -a[1]];
const abs2 = (a: C) => a[0] * a[0] + a[1] * a[1];

const S2 = Math.SQRT1_2;
const FIXED: Record<string, M2> = {
  I: [[[1, 0], [0, 0]], [[0, 0], [1, 0]]],
  X: [[[0, 0], [1, 0]], [[1, 0], [0, 0]]],
  Y: [[[0, 0], [0, -1]], [[0, 1], [0, 0]]],
  Z: [[[1, 0], [0, 0]], [[0, 0], [-1, 0]]],
  H: [[[S2, 0], [S2, 0]], [[S2, 0], [-S2, 0]]],
  S: [[[1, 0], [0, 0]], [[0, 0], [0, 1]]],
  SDG: [[[1, 0], [0, 0]], [[0, 0], [0, -1]]],
  T: [[[1, 0], [0, 0]], [[0, 0], [S2, S2]]],
  TDG: [[[1, 0], [0, 0]], [[0, 0], [S2, -S2]]],
};

function rotation(kind: 'RX' | 'RY' | 'RZ', theta: number): M2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  if (kind === 'RX') return [[[c, 0], [0, -s]], [[0, -s], [c, 0]]];
  if (kind === 'RY') return [[[c, 0], [-s, 0]], [[s, 0], [c, 0]]];
  return [[[c, -s], [0, 0]], [[0, 0], [c, s]]];
}

/** max |(U†U − I)_ij| for a 2×2 matrix. */
export function unitarityError(u: M2): number {
  let err = 0;
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      let s: C = [0, 0];
      for (let k = 0; k < 2; k += 1) s = cadd(s, cmul(conj(u[k]![i]!), u[k]![j]!));
      const target = i === j ? 1 : 0;
      err = Math.max(err, Math.hypot(s[0] - target, s[1]));
    }
  }
  return err;
}

/** A gate step: ["H", 0], ["CNOT", 0, 1], ["RZ", 2, 1.57], ["U", 0, [[a,b],[c,d]]] (entries [re, im]). */
export type GateStep = [string, ...unknown[]];

export interface CircuitClaim {
  qubits: number;
  gates: GateStep[];
  expect?: { probs?: Record<string, number>; tol?: number };
  shots?: number;
}

export interface CircuitResult {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  probs: Record<string, number>;
  maxUnitarityError: number;
  maxNormError: number;
  counts?: Record<string, number>;
  detail: string;
}

const UNITARY_TOL = 1e-9;
const NORM_TOL = 1e-9;

function applySingle(state: C[], n: number, q: number, u: M2): void {
  const bit = 1 << (n - 1 - q); // qubit 0 is the most significant bit
  for (let i = 0; i < state.length; i += 1) {
    if (i & bit) continue;
    const j = i | bit;
    const a = state[i]!;
    const b = state[j]!;
    state[i] = cadd(cmul(u[0][0], a), cmul(u[0][1], b));
    state[j] = cadd(cmul(u[1][0], a), cmul(u[1][1], b));
  }
}

function applyControlled(state: C[], n: number, control: number, target: number, u: M2): void {
  const cbit = 1 << (n - 1 - control);
  const tbit = 1 << (n - 1 - target);
  for (let i = 0; i < state.length; i += 1) {
    if (!(i & cbit) || i & tbit) continue;
    const j = i | tbit;
    const a = state[i]!;
    const b = state[j]!;
    state[i] = cadd(cmul(u[0][0], a), cmul(u[0][1], b));
    state[j] = cadd(cmul(u[1][0], a), cmul(u[1][1], b));
  }
}

function qubitIndex(v: unknown, n: number): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= n) throw new Error(`qubit index ${String(v)} out of range 0..${n - 1}`);
  return v as number;
}

function customMatrix(v: unknown): M2 {
  const ok = (c: unknown): c is C => Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!Array.isArray(v) || v.length !== 2 || !v.every((row) => Array.isArray(row) && row.length === 2 && row.every(ok))) {
    throw new Error('U must be [[[re,im],[re,im]],[[re,im],[re,im]]]');
  }
  return v as M2;
}

export function simulate(claim: CircuitClaim, seed: number): CircuitResult {
  const n = claim.qubits;
  const empty = { probs: {}, maxUnitarityError: 0, maxNormError: 0 };
  if (!Number.isInteger(n) || n < 1 || n > 12) return { verdict: 'ERROR', ...empty, detail: 'qubits must be 1..12' };
  if (!Array.isArray(claim.gates) || claim.gates.length > 2000) return { verdict: 'ERROR', ...empty, detail: 'gates must be a list (≤ 2000)' };
  const state: C[] = Array.from({ length: 1 << n }, (_, i) => (i === 0 ? [1, 0] : [0, 0]));
  let maxU = 0;
  let maxNorm = 0;
  try {
    for (const step of claim.gates) {
      const name = String(step[0]).toUpperCase();
      let u: M2;
      if (FIXED[name]) u = FIXED[name]!;
      else if (name === 'RX' || name === 'RY' || name === 'RZ') u = rotation(name, Number(step[2]));
      else if (name === 'U') u = customMatrix(step[2]);
      else if (name === 'CNOT' || name === 'CX' || name === 'CZ') u = name === 'CZ' ? FIXED.Z! : FIXED.X!;
      else if (name === 'SWAP') u = FIXED.X!;
      else throw new Error(`unknown gate "${step[0]}"`);

      const ue = unitarityError(u);
      maxU = Math.max(maxU, ue);
      if (ue > UNITARY_TOL) {
        return { verdict: 'FAIL', probs: {}, maxUnitarityError: maxU, maxNormError: maxNorm, detail: `gate ${name} is not unitary (‖U†U − I‖ = ${ue.toExponential(2)})` };
      }
      if (name === 'CNOT' || name === 'CX' || name === 'CZ') {
        const c = qubitIndex(step[1], n);
        const t = qubitIndex(step[2], n);
        if (c === t) throw new Error('control and target must differ');
        applyControlled(state, n, c, t, u);
      } else if (name === 'SWAP') {
        const a = qubitIndex(step[1], n);
        const b = qubitIndex(step[2], n);
        applyControlled(state, n, a, b, FIXED.X!);
        applyControlled(state, n, b, a, FIXED.X!);
        applyControlled(state, n, a, b, FIXED.X!);
      } else {
        applySingle(state, n, qubitIndex(step[1], n), u);
      }
      const norm = state.reduce((s, a) => s + abs2(a), 0);
      maxNorm = Math.max(maxNorm, Math.abs(norm - 1));
      if (Math.abs(norm - 1) > NORM_TOL) throw new Error(`normalization lost (Σ|ψ|² = ${norm})`);
    }
  } catch (err) {
    return { verdict: 'ERROR', probs: {}, maxUnitarityError: maxU, maxNormError: maxNorm, detail: (err as Error).message };
  }

  const probs: Record<string, number> = {};
  state.forEach((a, i) => {
    const p = abs2(a);
    if (p > 1e-12) probs[i.toString(2).padStart(n, '0')] = p;
  });

  let counts: Record<string, number> | undefined;
  if (claim.shots && Number.isInteger(claim.shots) && claim.shots > 0 && claim.shots <= 100_000) {
    const rand = mulberry32(seed);
    const keys = Object.keys(probs);
    counts = Object.fromEntries(keys.map((k) => [k, 0]));
    for (let s = 0; s < claim.shots; s += 1) {
      let r = rand();
      let hit = keys[keys.length - 1]!; // rounding remainder lands on the last outcome
      for (const k of keys) {
        r -= probs[k]!;
        if (r <= 0) {
          hit = k;
          break;
        }
      }
      counts[hit]! += 1;
    }
  }

  const tol = claim.expect?.tol ?? 1e-6;
  const mismatches: string[] = [];
  if (claim.expect?.probs) {
    const keys = new Set([...Object.keys(claim.expect.probs), ...Object.keys(probs)]);
    for (const k of keys) {
      const want = claim.expect.probs[k] ?? 0;
      const got = probs[k] ?? 0;
      if (Math.abs(want - got) > tol) mismatches.push(`P(${k}) = ${got.toFixed(6)}, claimed ${want}`);
    }
  }
  return {
    verdict: mismatches.length ? 'FAIL' : 'PASS',
    probs,
    maxUnitarityError: maxU,
    maxNormError: maxNorm,
    ...(counts ? { counts } : {}),
    detail: mismatches.length ? mismatches.slice(0, 6).join('; ') : `${claim.gates.length} gates, all unitary; normalization held; probabilities match`,
  };
}
