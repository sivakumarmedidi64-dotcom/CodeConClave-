import { describe, expect, it } from 'vitest';
import { verifyUnits } from './units.js';
import { bootstrapCi, holm, meanCi, tCdf, tQuantile, verifyStats, welchT } from './stats.js';
import { simulate, unitarityError } from './quantum.js';
import { verifyReactor } from './nuclear.js';
import { extractClaims, runKernel } from './index.js';

describe('units & dimensions', () => {
  it('accepts consistent physics formulas', () => {
    expect(verifyUnits('m*a', 'F', { m: 'kg', a: 'm/s^2', F: 'N' }).verdict).toBe('PASS');
    expect(verifyUnits('m*c^2', 'E', { m: 'kg', c: 'm/s', E: 'J' }).verdict).toBe('PASS');
    expect(verifyUnits('sqrt(2*g*h)', 'v', { g: 'm/s^2', h: 'm', v: 'm/s' }).verdict).toBe('PASS');
    expect(verifyUnits('P*V', 'n*R*T', { P: 'Pa', V: 'm^3', n: 'mol', R: 'J/(mol*K)', T: 'K' }).verdict).toBe('PASS');
  });
  it('rejects inconsistent ones with a reason', () => {
    expect(verifyUnits('m*a', 'E', { m: 'kg', a: 'm/s^2', E: 'J' })).toMatchObject({ verdict: 'FAIL', detail: expect.stringContaining('left is') });
    expect(verifyUnits('x + t', 'x', { x: 'm', t: 's' })).toMatchObject({ verdict: 'FAIL', detail: expect.stringContaining('cannot add') });
    expect(verifyUnits('sin(x)', '1', { x: 'm' }).verdict).toBe('FAIL');
    expect(verifyUnits('q', 'q', { q: 'furlong' }).verdict).toBe('ERROR');
  });
});

describe('statistics', () => {
  it('matches reference values for the t distribution', () => {
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228138852, 6);
    expect(tCdf(2.0, 5)).toBeCloseTo(0.9490302605, 6);
  });
  it('re-derives a Welch t-test and a CI', () => {
    const r = welchT([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r.t).toBeCloseTo(-1.8973665961, 8);
    expect(r.df).toBeCloseTo(5.882352941, 6);
    expect(r.p).toBeGreaterThan(0.1);
    expect(r.p).toBeLessThan(0.12);
    const ci = meanCi([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(ci.mean).toBe(5);
    expect(ci.lo).toBeLessThan(5);
  });
  it('applies the Holm correction', () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });
  it('seeded bootstrap is reproducible', () => {
    expect(bootstrapCi([1, 2, 3, 4, 5, 6], 7)).toEqual(bootstrapCi([1, 2, 3, 4, 5, 6], 7));
  });
  it('hashes the analysis plan and judges claimed results', () => {
    const ok = verifyStats({ plan: { test: 'welch_t', alpha: 0.05 }, data: { a: [1, 2, 3, 4, 5], b: [9, 10, 11, 12, 13] }, expect: { p_lt: 0.05 } });
    expect(ok.verdict).toBe('PASS');
    expect(ok.planHash).toMatch(/^[0-9a-f]{64}$/);
    const overclaim = verifyStats({ plan: { test: 'welch_t' }, data: { a: [1, 2, 3, 4, 5], b: [2, 4, 6, 8, 10] }, expect: { p_lt: 0.05 } });
    expect(overclaim).toMatchObject({ verdict: 'FAIL', detail: expect.stringContaining('is not < 0.05') });
    expect(verifyStats({ plan: { test: 'welch_t' }, data: { a: [1] } }).verdict).toBe('ERROR');
  });
});

describe('quantum state-vector simulator', () => {
  it('prepares a Bell state', () => {
    const r = simulate({ qubits: 2, gates: [['H', 0], ['CNOT', 0, 1]], expect: { probs: { '00': 0.5, '11': 0.5 } } }, 1);
    expect(r.verdict).toBe('PASS');
    expect(r.maxUnitarityError).toBeLessThan(1e-12);
    expect(r.maxNormError).toBeLessThan(1e-12);
  });
  it('uses qubit 0 as the leftmost bit', () => {
    expect(simulate({ qubits: 2, gates: [['X', 1]] }, 1).probs).toEqual({ '01': 1 });
  });
  it('rejects a non-unitary gate', () => {
    expect(unitarityError([[[1, 0], [0, 0]], [[0, 0], [2, 0]]])).toBeGreaterThan(1);
    const r = simulate({ qubits: 1, gates: [['U', 0, [[[1, 0], [0, 0]], [[0, 0], [2, 0]]]]] }, 1);
    expect(r).toMatchObject({ verdict: 'FAIL', detail: expect.stringContaining('not unitary') });
  });
  it('catches a wrong probability claim', () => {
    expect(simulate({ qubits: 1, gates: [['H', 0]], expect: { probs: { '0': 1 } } }, 1).verdict).toBe('FAIL');
  });
  it('seeded shots are reproducible and sum to the shot count', () => {
    const a = simulate({ qubits: 1, gates: [['H', 0]], shots: 1000 }, 42);
    expect(a.counts).toEqual(simulate({ qubits: 1, gates: [['H', 0]], shots: 1000 }, 42).counts);
    expect(Object.values(a.counts!).reduce((x, y) => x + y, 0)).toBe(1000);
  });
});

describe('civil reactor physics', () => {
  it('six-factor formula', () => {
    const r = verifyReactor({ model: 'six_factor', params: { eta: 2.02, f: 0.71, p: 0.87, eps: 1.03 }, expect: { k_inf: 1.28518662 } });
    expect(r.verdict).toBe('PASS');
    expect(verifyReactor({ model: 'six_factor', params: { eta: 2, f: 1.4, p: 0.9, eps: 1.0 }, expect: {} }).verdict).toBe('ERROR');
  });
  it('bare one-group sphere: critical radius and k_eff = 1 there, with neutron balance', () => {
    const params = { nuSigmaF: 0.0175, sigmaA: 0.015, D: 1.0, R: Math.PI / 0.05 };
    const r = verifyReactor({ model: 'bare_one_group', geometry: 'sphere', params, expect: { k_eff: 1, critical_radius: 62.8319 } });
    expect(r.verdict).toBe('PASS');
    expect(Math.abs(r.outputs.balance_residual!)).toBeLessThan(1e-12);
  });
  it('radioactive decay', () => {
    expect(verifyReactor({ model: 'decay', params: { halfLife: 5730, N0: 1000, t: 5730 }, expect: { N: 500 } }).verdict).toBe('PASS');
    expect(verifyReactor({ model: 'decay', params: { halfLife: 5730, N0: 1000, t: 5730 }, expect: { N: 600 } }).verdict).toBe('FAIL');
  });
});

describe('kernel: claims → hashed proofs', () => {
  const answer = [
    'Here is the result.',
    '```claims',
    JSON.stringify([
      { kind: 'identity', lhs: '(a-b)(a+b)', rhs: 'a^2-b^2' },
      { kind: 'units', lhs: 'm*a', rhs: 'F', symbols: { m: 'kg', a: 'm/s^2', F: 'N' } },
      { kind: 'circuit', qubits: 1, gates: [['X', 0]], expect: { probs: { '1': 1 } } },
      { kind: 'numeric', expr: 'sqrt(16)', value: 5 },
    ]),
    '```',
  ].join('\n');

  it('extracts the claims block and strips it from the answer', () => {
    const { claims, errors, text } = extractClaims(answer);
    expect(claims).toHaveLength(4);
    expect(errors).toEqual([]);
    expect(text).toBe('Here is the result.');
  });

  it('reports bad claims blocks instead of ignoring them', () => {
    expect(extractClaims('```claims\nnot json\n```').errors[0]).toMatch(/not valid JSON/);
    expect(extractClaims('```claims\n[{"kind":"magic"}]\n```').errors[0]).toMatch(/unknown claim/);
  });

  it('verifies each claim, hashes every proof, and rolls them up reproducibly', () => {
    const { claims } = extractClaims(answer);
    const r1 = runKernel(claims, 'run_1');
    expect(r1).toMatchObject({ passed: 3, failed: 1, errors: 0 });
    expect(r1.proofs.map((p) => p.verifier)).toEqual(['cas', 'units', 'quantum', 'cas']);
    expect(r1.proofs.every((p) => /^[0-9a-f]{64}$/.test(p.proofHash))).toBe(true);
    expect(runKernel(claims, 'run_1').rollupHash).toBe(r1.rollupHash); // deterministic
    expect(runKernel([], 'x').rollupHash).toBeNull();
  });
});
