/**
 * Exact multivariate polynomials + rational functions over Q — the symbolic
 * (CAS) half of the identity check. An expression built from numbers,
 * variables, + − × ÷ and integer powers normalizes to num/den; an identity
 * lhs = rhs holds symbolically iff lhs.num·rhs.den − rhs.num·lhs.den ≡ 0.
 * Anything else (sin, exp, symbolic exponents) is "not polynomial" and the
 * caller falls back to seeded numeric checks — never a guessed verdict.
 */
import { Q } from './rational.js';
import type { Node } from './expr.js';

/** Monomial key: sorted "x^2*y" (empty string = constant term). */
export type Poly = Map<string, Q>;

const MAX_TERMS = 5000;
const MAX_POWER = 64;

export class NotPolynomial extends Error {}

function parseKey(key: string): Map<string, number> {
  const m = new Map<string, number>();
  if (!key) return m;
  for (const part of key.split('*')) {
    const [v, e] = part.split('^');
    m.set(v!, Number(e ?? 1));
  }
  return m;
}

function makeKey(m: Map<string, number>): string {
  return [...m.entries()]
    .filter(([, e]) => e !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([v, e]) => (e === 1 ? v : `${v}^${e}`))
    .join('*');
}

export function constant(q: Q): Poly {
  return q.isZero() ? new Map() : new Map([['', q]]);
}

function variable(name: string): Poly {
  return new Map([[name, Q.ONE]]);
}

export function add(a: Poly, b: Poly, sign = 1): Poly {
  const out = new Map(a);
  for (const [k, c] of b) {
    const next = (out.get(k) ?? Q.ZERO).add(sign < 0 ? c.neg() : c);
    if (next.isZero()) out.delete(k);
    else out.set(k, next);
  }
  if (out.size > MAX_TERMS) throw new NotPolynomial('too many terms');
  return out;
}

export function mul(a: Poly, b: Poly): Poly {
  let out: Poly = new Map();
  for (const [ka, ca] of a) {
    const ma = parseKey(ka);
    for (const [kb, cb] of b) {
      const m = new Map(ma);
      for (const [v, e] of parseKey(kb)) m.set(v, (m.get(v) ?? 0) + e);
      out = add(out, new Map([[makeKey(m), ca.mul(cb)]]));
    }
  }
  return out;
}

function powPoly(a: Poly, k: number): Poly {
  let out = constant(Q.ONE);
  for (let i = 0; i < k; i += 1) out = mul(out, a);
  return out;
}

export function isZero(p: Poly): boolean {
  return p.size === 0;
}

/** A rational function num/den with polynomial parts. */
export interface Rational {
  num: Poly;
  den: Poly;
}

/** Normalize an expression to num/den, or throw NotPolynomial. */
export function toRational(node: Node): Rational {
  switch (node.t) {
    case 'num':
      return { num: constant(Q.parse(node.v)), den: constant(Q.ONE) };
    case 'var':
      if (node.name === 'pi' || node.name === 'e') throw new NotPolynomial('transcendental constant');
      return { num: variable(node.name), den: constant(Q.ONE) };
    case 'neg': {
      const a = toRational(node.a);
      return { num: add(new Map(), a.num, -1), den: a.den };
    }
    case 'call':
      throw new NotPolynomial(`function ${node.fn}`);
    case 'bin': {
      if (node.op === '^') {
        const base = toRational(node.l);
        const exp = exponentOf(node.r);
        if (exp >= 0) return { num: powPoly(base.num, exp), den: powPoly(base.den, exp) };
        if (isZero(base.num)) throw new NotPolynomial('zero to a negative power');
        return { num: powPoly(base.den, -exp), den: powPoly(base.num, -exp) };
      }
      const l = toRational(node.l);
      const r = toRational(node.r);
      switch (node.op) {
        case '+':
          return { num: add(mul(l.num, r.den), mul(r.num, l.den)), den: mul(l.den, r.den) };
        case '-':
          return { num: add(mul(l.num, r.den), mul(r.num, l.den), -1), den: mul(l.den, r.den) };
        case '*':
          return { num: mul(l.num, r.num), den: mul(l.den, r.den) };
        case '/':
          if (isZero(r.num)) throw new NotPolynomial('division by zero');
          return { num: mul(l.num, r.den), den: mul(l.den, r.num) };
      }
    }
  }
  throw new NotPolynomial('unsupported');
}

/** Integer exponent literal (possibly negated), bounded. */
function exponentOf(node: Node): number {
  let sign = 1;
  let n = node;
  while (n.t === 'neg') {
    sign = -sign;
    n = n.a;
  }
  if (n.t !== 'num') throw new NotPolynomial('symbolic exponent');
  const q = Q.parse(n.v);
  if (!q.isInteger()) throw new NotPolynomial('fractional exponent');
  const k = Number(q.n) * sign;
  if (Math.abs(k) > MAX_POWER) throw new NotPolynomial('exponent too large');
  return k;
}

/** Symbolic residual numerator of lhs − rhs (empty map = identically zero). */
export function residual(lhs: Rational, rhs: Rational): Poly {
  return add(mul(lhs.num, rhs.den), mul(rhs.num, lhs.den), -1);
}

export function showPoly(p: Poly, maxTerms = 12): string {
  if (p.size === 0) return '0';
  const parts = [...p.entries()].slice(0, maxTerms).map(([k, c], i) => {
    const neg = c.n < 0n;
    const mag = neg ? c.neg() : c;
    const body = k ? (mag.equals(Q.ONE) ? k : `${mag}*${k}`) : mag.toString();
    return i === 0 ? (neg ? `-${body}` : body) : `${neg ? '-' : '+'} ${body}`;
  });
  return parts.join(' ') + (p.size > maxTerms ? ` + … (${p.size - maxTerms} more terms)` : '');
}
