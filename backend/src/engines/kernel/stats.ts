/**
 * Statistics verifier. Pure, deterministic re-derivation of the numbers a
 * statistical claim rests on: mean, SD, confidence intervals (Student t),
 * Welch / one-sample t-tests, Cohen's d effect size, Holm multiplicity
 * correction, and a seeded bootstrap. The analysis plan is hashed BEFORE any
 * number is computed, so the plan can't be tuned to the result.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../modules/audit/chain.js';
import { mulberry32 } from './rng.js';

// ---------------------------------------------------------------- special functions

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t CDF. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * incBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student t quantile by bisection on the CDF. */
export function tQuantile(p: number, df: number): number {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- descriptive

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}
export const sd = (xs: number[]) => Math.sqrt(variance(xs));

export function meanCi(xs: number[], alpha = 0.05): { mean: number; lo: number; hi: number; df: number } {
  const n = xs.length;
  const m = mean(xs);
  const half = tQuantile(1 - alpha / 2, n - 1) * (sd(xs) / Math.sqrt(n));
  return { mean: m, lo: m - half, hi: m + half, df: n - 1 };
}

export function welchT(a: number[], b: number[]): { t: number; df: number; p: number } {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, df, p: 2 * (1 - tCdf(Math.abs(t), df)) };
}

export function oneSampleT(xs: number[], mu0: number): { t: number; df: number; p: number } {
  const t = (mean(xs) - mu0) / (sd(xs) / Math.sqrt(xs.length));
  const df = xs.length - 1;
  return { t, df, p: 2 * (1 - tCdf(Math.abs(t), df)) };
}

/** Cohen's d with pooled SD. */
export function cohensD(a: number[], b: number[]): number {
  const pooled = Math.sqrt(((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2));
  return (mean(a) - mean(b)) / pooled;
}

/** Holm–Bonferroni adjusted p-values (same order as input). */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(ps.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    adj[i] = running;
  });
  return adj;
}

/** Seeded percentile bootstrap CI for the mean. */
export function bootstrapCi(xs: number[], seed: number, b = 2000, alpha = 0.05): { lo: number; hi: number } {
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < b; i += 1) {
    let s = 0;
    for (let j = 0; j < xs.length; j += 1) s += xs[Math.floor(rand() * xs.length)]!;
    means.push(s / xs.length);
  }
  means.sort((x, y) => x - y);
  return { lo: means[Math.floor((alpha / 2) * b)]!, hi: means[Math.ceil((1 - alpha / 2) * b) - 1]! };
}

// ---------------------------------------------------------------- claims

export interface StatsPlan {
  test: 'welch_t' | 'one_sample_t' | 'mean_ci';
  alpha?: number;
  mu0?: number;
  correction?: 'holm' | 'none';
}

export interface StatsClaim {
  plan: StatsPlan;
  data: { a: number[]; b?: number[] };
  expect?: { p_lt?: number; p?: number; ci?: [number, number]; effect?: number; tol?: number };
}

export interface StatsResult {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  planHash: string;
  outputs: Record<string, number | [number, number]>;
  detail: string;
}

export function planHash(plan: StatsPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

function validSample(xs: unknown, min: number): xs is number[] {
  return Array.isArray(xs) && xs.length >= min && xs.length <= 100_000 && xs.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** `adjustedP` is supplied by the kernel when several tests share a Holm correction. */
export function verifyStats(claim: StatsClaim, adjustedP?: number): StatsResult {
  const hash = planHash(claim.plan); // hashed before anything is computed
  const alpha = claim.plan.alpha ?? 0.05;
  const tol = claim.expect?.tol ?? 1e-3;
  try {
    const out: StatsResult['outputs'] = {};
    if (!validSample(claim.data?.a, 2)) throw new Error('data.a must be 2+ finite numbers');
    if (claim.plan.test === 'welch_t') {
      if (!validSample(claim.data.b, 2)) throw new Error('data.b must be 2+ finite numbers');
      const r = welchT(claim.data.a, claim.data.b);
      Object.assign(out, { t: r.t, df: r.df, p: r.p, effect: cohensD(claim.data.a, claim.data.b) });
    } else if (claim.plan.test === 'one_sample_t') {
      const r = oneSampleT(claim.data.a, claim.plan.mu0 ?? 0);
      Object.assign(out, { t: r.t, df: r.df, p: r.p });
    } else if (claim.plan.test === 'mean_ci') {
      const ci = meanCi(claim.data.a, alpha);
      Object.assign(out, { mean: ci.mean, ci: [ci.lo, ci.hi] as [number, number] });
    } else {
      throw new Error(`unknown test "${String((claim.plan as { test?: unknown }).test)}"`);
    }
    if (adjustedP !== undefined) out.p_adjusted = adjustedP;
    const p = (out.p_adjusted ?? out.p) as number | undefined;

    const failures: string[] = [];
    const e = claim.expect ?? {};
    if (e.p_lt !== undefined && !(p !== undefined && p < e.p_lt)) failures.push(`p = ${p?.toPrecision(4)} is not < ${e.p_lt}`);
    if (e.p !== undefined && !(p !== undefined && Math.abs(p - e.p) <= tol)) failures.push(`p = ${p?.toPrecision(4)}, claimed ${e.p}`);
    if (e.ci && out.ci) {
      const [lo, hi] = out.ci as [number, number];
      if (Math.abs(lo - e.ci[0]) > tol || Math.abs(hi - e.ci[1]) > tol) failures.push(`CI = [${lo.toPrecision(5)}, ${hi.toPrecision(5)}], claimed [${e.ci.join(', ')}]`);
    }
    if (e.effect !== undefined && out.effect !== undefined && Math.abs((out.effect as number) - e.effect) > tol) {
      failures.push(`effect size d = ${(out.effect as number).toPrecision(4)}, claimed ${e.effect}`);
    }
    return {
      verdict: failures.length ? 'FAIL' : 'PASS',
      planHash: hash,
      outputs: out,
      detail: failures.length ? failures.join('; ') : `${claim.plan.test} re-derived; claims hold`,
    };
  } catch (err) {
    return { verdict: 'ERROR', planHash: hash, outputs: {}, detail: (err as Error).message };
  }
}
