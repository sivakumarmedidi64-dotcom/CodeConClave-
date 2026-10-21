/**
 * Units & dimensions checker (SI). A formula is dimensionally consistent when
 * both sides reduce to the same base-dimension vector [m, kg, s, A, K, mol, cd];
 * sums need matching dimensions, function arguments must be dimensionless.
 */
import { parse, type Node } from './expr.js';

export type Dim = [number, number, number, number, number, number, number];
const D = (m = 0, kg = 0, s = 0, A = 0, K = 0, mol = 0, cd = 0): Dim => [m, kg, s, A, K, mol, cd];
const ZERO = D();

/** Unit symbol → dimension (scale factors don't matter for consistency). */
export const UNITS: Record<string, Dim> = {
  1: ZERO,
  m: D(1),
  km: D(1),
  cm: D(1),
  mm: D(1),
  nm: D(1),
  fm: D(1),
  g: D(0, 1),
  kg: D(0, 1),
  u: D(0, 1),
  s: D(0, 0, 1),
  ms: D(0, 0, 1),
  min: D(0, 0, 1),
  h: D(0, 0, 1),
  A: D(0, 0, 0, 1),
  K: D(0, 0, 0, 0, 1),
  mol: D(0, 0, 0, 0, 0, 1),
  cd: D(0, 0, 0, 0, 0, 0, 1),
  Hz: D(0, 0, -1),
  N: D(1, 1, -2),
  Pa: D(-1, 1, -2),
  J: D(2, 1, -2),
  eV: D(2, 1, -2),
  MeV: D(2, 1, -2),
  W: D(2, 1, -3),
  C: D(0, 0, 1, 1),
  V: D(2, 1, -3, -1),
  Ohm: D(2, 1, -3, -2),
  F: D(-2, -1, 4, 2),
  T: D(0, 1, -2, -1),
  Wb: D(2, 1, -2, -1),
  H: D(2, 1, -2, -2),
  Bq: D(0, 0, -1),
  Gy: D(2, 0, -2),
  Sv: D(2, 0, -2),
  L: D(3),
  barn: D(2),
  rad: ZERO,
  sr: ZERO,
};

const eq = (a: Dim, b: Dim) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);
const add = (a: Dim, b: Dim, k = 1): Dim => a.map((x, i) => x + k * b[i]!) as Dim;
const scale = (a: Dim, k: number): Dim => a.map((x) => x * k) as Dim;

export function showDim(d: Dim): string {
  const names = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd'];
  const parts = d.map((e, i) => (e === 0 ? '' : e === 1 ? names[i] : `${names[i]}^${e}`)).filter(Boolean);
  return parts.length ? parts.join('·') : 'dimensionless';
}

/** Dimension of a unit expression like "kg*m/s^2" or "J/(mol*K)". */
export function unitDim(unit: string): Dim {
  return dimOf(parse(unit), (name) => {
    const d = UNITS[name];
    if (!d) throw new Error(`unknown unit "${name}"`);
    return d;
  });
}

function numberValue(node: Node): number | null {
  if (node.t === 'num') return Number(node.v);
  if (node.t === 'neg') {
    const v = numberValue(node.a);
    return v === null ? null : -v;
  }
  return null;
}

function dimOf(node: Node, lookup: (name: string) => Dim): Dim {
  switch (node.t) {
    case 'num':
      return ZERO;
    case 'var':
      return node.name === 'pi' || node.name === 'e' ? ZERO : lookup(node.name);
    case 'neg':
      return dimOf(node.a, lookup);
    case 'call': {
      // sqrt halves dimensions and abs keeps them; every other function
      // (sin, exp, ln…) needs a dimensionless argument.
      if (node.fn === 'sqrt' && node.args.length === 1) return scale(dimOf(node.args[0]!, lookup), 0.5);
      if (node.fn === 'abs' && node.args.length === 1) return dimOf(node.args[0]!, lookup);
      for (const a of node.args) {
        const d = dimOf(a, lookup);
        if (!eq(d, ZERO)) throw new Error(`${node.fn}() needs a dimensionless argument, got ${showDim(d)}`);
      }
      return ZERO;
    }
    case 'bin': {
      if (node.op === '^') {
        const k = numberValue(node.r);
        const base = dimOf(node.l, lookup);
        if (k === null) {
          if (!eq(base, ZERO)) throw new Error('symbolic exponent on a dimensional quantity');
          return ZERO;
        }
        return scale(base, k);
      }
      if (node.op === '*' || node.op === '/') {
        return add(dimOf(node.l, lookup), dimOf(node.r, lookup), node.op === '*' ? 1 : -1);
      }
      const l = dimOf(node.l, lookup);
      const r = dimOf(node.r, lookup);
      if (!eq(l, r)) throw new Error(`cannot ${node.op === '+' ? 'add' : 'subtract'} ${showDim(l)} and ${showDim(r)}`);
      return l;
    }
  }
}

export interface UnitsResult {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  lhs?: string;
  rhs?: string;
  detail: string;
}

/** Check lhs and rhs have the same dimensions, given each symbol's unit. */
export function verifyUnits(lhsSrc: string, rhsSrc: string, symbols: Record<string, string>): UnitsResult {
  try {
    const dims: Record<string, Dim> = {};
    for (const [sym, unit] of Object.entries(symbols)) dims[sym] = unitDim(unit);
    const lookup = (name: string) => {
      const d = dims[name];
      if (!d) throw new Error(`no unit given for "${name}"`);
      return d;
    };
    const l = dimOf(parse(lhsSrc), lookup);
    const r = dimOf(parse(rhsSrc), lookup);
    const ok = eq(l, r);
    return {
      verdict: ok ? 'PASS' : 'FAIL',
      lhs: showDim(l),
      rhs: showDim(r),
      detail: ok ? `both sides are ${showDim(l)}` : `left is ${showDim(l)}, right is ${showDim(r)}`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    // An inconsistent sum or bad function argument is a real dimensional error.
    return { verdict: /cannot (add|subtract)|dimensionless argument|symbolic exponent/.test(msg) ? 'FAIL' : 'ERROR', detail: msg };
  }
}
