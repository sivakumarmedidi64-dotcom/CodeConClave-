/**
 * Computational Mathematics verifier.
 *   identity    lhs = rhs: symbolic residual (exact, over Q) when the
 *               expression is polynomial/rational, AND ≥3 seeded numeric
 *               points always. Both must agree.
 *   derivative  d/dvar f = g  — symbolic differentiation, then an identity.
 *   integral    ∫ f d(var) = F — verified as dF/dvar = f (up to a constant).
 *   numeric     expr ≈ value within tol.
 */
import { evaluate, parse, show, variables, type Node } from './expr.js';
import { NotPolynomial, isZero, residual, showPoly, toRational } from './poly.js';
import { mulberry32 } from './rng.js';

export interface IdentityResult {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  method: 'symbolic+numeric' | 'numeric';
  symbolic: 'zero' | 'nonzero' | 'n/a';
  residual?: string;
  numeric: { points: number; maxDiff: number; tol: number; seed: number; counterexample?: Record<string, number> };
  detail: string;
}

const MIN_POINTS = 3;
const POINTS = 5;

function close(a: number, b: number, rel: number): boolean {
  return Math.abs(a - b) <= rel * (1 + Math.abs(a) + Math.abs(b));
}

/** Check lhs ≡ rhs. `range` is where numeric points are drawn ([-2, 2] default). */
export function verifyIdentity(lhsSrc: string, rhsSrc: string, seed: number, range: [number, number] = [-2, 2]): IdentityResult {
  let lhs: Node;
  let rhs: Node;
  try {
    lhs = parse(lhsSrc);
    rhs = parse(rhsSrc);
  } catch (err) {
    return errorResult(`could not parse: ${(err as Error).message}`, seed);
  }
  return verifyIdentityNodes(lhs, rhs, seed, range);
}

export function verifyIdentityNodes(lhs: Node, rhs: Node, seed: number, range: [number, number] = [-2, 2]): IdentityResult {
  // 1. Symbolic residual over Q (exact) when both sides are rational functions.
  let symbolic: IdentityResult['symbolic'] = 'n/a';
  let residualText: string | undefined;
  try {
    const r = residual(toRational(lhs), toRational(rhs));
    symbolic = isZero(r) ? 'zero' : 'nonzero';
    if (!isZero(r)) residualText = showPoly(r);
  } catch (err) {
    if (!(err instanceof NotPolynomial)) return errorResult(`symbolic check failed: ${(err as Error).message}`, seed);
  }

  // 2. Numeric spot checks at seeded random points (always).
  const vars = [...new Set([...variables(lhs), ...variables(rhs)])].sort();
  const rand = mulberry32(seed);
  const tol = 1e-9;
  let points = 0;
  let maxDiff = 0;
  let counterexample: Record<string, number> | undefined;
  for (let attempt = 0; attempt < 40 && points < POINTS; attempt += 1) {
    const env: Record<string, number> = {};
    for (const v of vars) env[v] = range[0] + rand() * (range[1] - range[0]);
    let a: number;
    let b: number;
    try {
      a = evaluate(lhs, env);
      b = evaluate(rhs, env);
    } catch (err) {
      return errorResult(`could not evaluate: ${(err as Error).message}`, seed);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue; // outside the domain (e.g. pole) — redraw
    points += 1;
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
    if (!close(a, b, tol) && !counterexample) counterexample = env;
  }
  const numeric = { points, maxDiff, tol, seed, ...(counterexample ? { counterexample } : {}) };
  if (points < MIN_POINTS) {
    return { verdict: 'ERROR', method: 'numeric', symbolic, residual: residualText, numeric, detail: `only ${points} finite evaluation points (need ${MIN_POINTS})` };
  }
  const numericOk = !counterexample;

  if (symbolic === 'zero') {
    return numericOk
      ? { verdict: 'PASS', method: 'symbolic+numeric', symbolic, numeric, detail: `symbolic residual = 0; ${points} seeded points agree` }
      : { verdict: 'ERROR', method: 'symbolic+numeric', symbolic, numeric, detail: 'symbolic and numeric checks disagree (kernel fault)' };
  }
  if (symbolic === 'nonzero') {
    return { verdict: 'FAIL', method: 'symbolic+numeric', symbolic, residual: residualText, numeric, detail: `symbolic residual ≠ 0: ${residualText}` };
  }
  return numericOk
    ? { verdict: 'PASS', method: 'numeric', symbolic, numeric, detail: `not polynomial — ${points} seeded points agree within ${tol}` }
    : { verdict: 'FAIL', method: 'numeric', symbolic, numeric, detail: `differs at ${JSON.stringify(counterexample)}` };
}

function errorResult(detail: string, seed: number): IdentityResult {
  return { verdict: 'ERROR', method: 'numeric', symbolic: 'n/a', numeric: { points: 0, maxDiff: 0, tol: 1e-9, seed }, detail };
}

// ---------------------------------------------------------------- calculus

const num = (v: string): Node => ({ t: 'num', v });
const bin = (op: '+' | '-' | '*' | '/' | '^', l: Node, r: Node): Node => ({ t: 'bin', op, l, r });
const call = (fn: string, a: Node): Node => ({ t: 'call', fn, args: [a] });

function dependsOn(node: Node, v: string): boolean {
  return variables(node).has(v);
}

/** Symbolic derivative d(node)/d(v). Throws on unsupported functions. */
export function derivative(node: Node, v: string): Node {
  switch (node.t) {
    case 'num':
      return num('0');
    case 'var':
      return num(node.name === v ? '1' : '0');
    case 'neg':
      return { t: 'neg', a: derivative(node.a, v) };
    case 'bin': {
      const { l, r } = node;
      switch (node.op) {
        case '+':
        case '-':
          return bin(node.op, derivative(l, v), derivative(r, v));
        case '*':
          return bin('+', bin('*', derivative(l, v), r), bin('*', l, derivative(r, v)));
        case '/':
          return bin('/', bin('-', bin('*', derivative(l, v), r), bin('*', l, derivative(r, v))), bin('^', r, num('2')));
        case '^':
          if (!dependsOn(r, v)) {
            // d(u^c) = c·u^(c−1)·u'  (integer c stays a literal so the result is still polynomial)
            const lower = r.t === 'num' && /^\d+$/.test(r.v) ? num(String(Number(r.v) - 1)) : bin('-', r, num('1'));
            return bin('*', bin('*', r, bin('^', l, lower)), derivative(l, v));
          }
          // d(u^w) = u^w · (w'·ln u + w·u'/u)
          return bin('*', node, bin('+', bin('*', derivative(r, v), call('ln', l)), bin('/', bin('*', r, derivative(l, v)), l)));
      }
      break;
    }
    case 'call': {
      if (node.args.length !== 1) throw new Error(`d/d${v} of ${node.fn} with ${node.args.length} arguments`);
      const u = node.args[0]!;
      const du = derivative(u, v);
      const chain = (outer: Node): Node => bin('*', outer, du);
      switch (node.fn) {
        case 'sin':
          return chain(call('cos', u));
        case 'cos':
          return chain({ t: 'neg', a: call('sin', u) });
        case 'tan':
          return chain(bin('/', num('1'), bin('^', call('cos', u), num('2'))));
        case 'exp':
          return chain(call('exp', u));
        case 'ln':
        case 'log':
          return chain(bin('/', num('1'), u));
        case 'sqrt':
          return chain(bin('/', num('1'), bin('*', num('2'), call('sqrt', u))));
        case 'sinh':
          return chain(call('cosh', u));
        case 'cosh':
          return chain(call('sinh', u));
        case 'atan':
          return chain(bin('/', num('1'), bin('+', num('1'), bin('^', u, num('2')))));
        default:
          throw new Error(`no derivative rule for ${node.fn}`);
      }
    }
  }
  throw new Error('bad node');
}

export function verifyDerivative(fSrc: string, v: string, gSrc: string, seed: number): IdentityResult & { derived?: string } {
  try {
    const d = derivative(parse(fSrc), v);
    return { ...verifyIdentityNodes(d, parse(gSrc), seed, [0.2, 2]), derived: show(d) };
  } catch (err) {
    return errorResult(`derivative: ${(err as Error).message}`, seed);
  }
}

/** ∫ f dv = F holds iff dF/dv = f (antiderivatives differ by a constant). */
export function verifyIntegral(fSrc: string, v: string, FSrc: string, seed: number): IdentityResult {
  try {
    return verifyIdentityNodes(derivative(parse(FSrc), v), parse(fSrc), seed, [0.2, 2]);
  } catch (err) {
    return errorResult(`integral: ${(err as Error).message}`, seed);
  }
}

export function verifyNumeric(exprSrc: string, value: number, tol: number): { verdict: 'PASS' | 'FAIL' | 'ERROR'; actual?: number; detail: string } {
  try {
    const actual = evaluate(parse(exprSrc), {});
    if (!Number.isFinite(actual)) return { verdict: 'ERROR', detail: 'not a finite number' };
    const ok = Math.abs(actual - value) <= tol;
    return { verdict: ok ? 'PASS' : 'FAIL', actual, detail: `${exprSrc} = ${actual} (claimed ${value} ± ${tol})` };
  } catch (err) {
    return { verdict: 'ERROR', detail: (err as Error).message };
  }
}
