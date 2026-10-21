import { describe, expect, it } from 'vitest';
import { Q } from './rational.js';
import { evaluate, parse } from './expr.js';
import { verifyDerivative, verifyIdentity, verifyIntegral, verifyNumeric } from './cas.js';

describe('exact rationals', () => {
  it('parses decimals exactly and normalizes', () => {
    expect(Q.parse('0.1').add(Q.parse('0.2')).equals(Q.parse('0.3'))).toBe(true); // no float error
    expect(Q.parse('1.5e2').toString()).toBe('150');
    expect(new Q(6n, -4n).toString()).toBe('-3/2');
  });
});

describe('expression parser', () => {
  it('handles precedence, right-assoc powers, implicit multiplication and functions', () => {
    expect(evaluate(parse('2 + 3*4^2'), {})).toBe(50);
    expect(evaluate(parse('2^3^2'), {})).toBe(512);
    expect(evaluate(parse('2x(x+1)'), { x: 3 })).toBe(24);
    expect(evaluate(parse('-x^2'), { x: 3 })).toBe(-9);
    expect(evaluate(parse('sin(pi/2) + ln(e)'), {})).toBeCloseTo(2);
    expect(() => parse('2 +* 3')).toThrow();
    expect(() => parse('x'.repeat(5000))).toThrow(/too long/);
  });
});

describe('identity: symbolic residual + seeded numeric points', () => {
  it('proves a polynomial identity exactly', () => {
    const r = verifyIdentity('(x+y)^3', 'x^3 + 3x^2y + 3x y^2 + y^3', 42);
    expect(r).toMatchObject({ verdict: 'PASS', method: 'symbolic+numeric', symbolic: 'zero' });
    expect(r.numeric.points).toBeGreaterThanOrEqual(3);
  });

  it('proves a rational-function identity exactly', () => {
    expect(verifyIdentity('1/(x-1) - 1/(x+1)', '2/(x^2-1)', 7)).toMatchObject({ verdict: 'PASS', symbolic: 'zero' });
  });

  it('rejects a false identity and shows the residual', () => {
    const r = verifyIdentity('(x+1)^2', 'x^2 + 1', 1);
    expect(r).toMatchObject({ verdict: 'FAIL', symbolic: 'nonzero' });
    expect(r.residual).toBe('2*x');
  });

  it('falls back to numeric checks for transcendental identities (honestly labelled)', () => {
    expect(verifyIdentity('sin(x)^2 + cos(x)^2', '1', 3)).toMatchObject({ verdict: 'PASS', method: 'numeric', symbolic: 'n/a' });
    const bad = verifyIdentity('sin(2x)', '2sin(x)', 3);
    expect(bad.verdict).toBe('FAIL');
    expect(bad.numeric.counterexample).toBeDefined();
  });

  it('is reproducible: the same seed draws the same points', () => {
    const a = verifyIdentity('exp(x)*exp(y)', 'exp(x+y)', 99);
    const b = verifyIdentity('exp(x)*exp(y)', 'exp(x+y)', 99);
    expect(a.numeric).toEqual(b.numeric);
  });

  it('reports errors instead of guessing', () => {
    expect(verifyIdentity('2 +* x', 'x', 1).verdict).toBe('ERROR'); // unparseable
    expect(verifyIdentity('sqrt(-1-x^2)', '0', 1).verdict).toBe('ERROR'); // never finite
  });
});

describe('calculus claims', () => {
  it('verifies derivatives symbolically when polynomial', () => {
    expect(verifyDerivative('x^3 + 2x', 'x', '3x^2 + 2', 5)).toMatchObject({ verdict: 'PASS', symbolic: 'zero' });
  });
  it('verifies transcendental derivatives numerically and catches wrong ones', () => {
    expect(verifyDerivative('sin(x)*exp(x)', 'x', 'exp(x)*(sin(x)+cos(x))', 5).verdict).toBe('PASS');
    expect(verifyDerivative('ln(x)', 'x', 'x', 5).verdict).toBe('FAIL');
  });
  it('verifies integrals via the derivative of the antiderivative', () => {
    expect(verifyIntegral('x*exp(x)', 'x', '(x-1)*exp(x)', 5).verdict).toBe('PASS');
    expect(verifyIntegral('1/x', 'x', 'x^2', 5).verdict).toBe('FAIL');
  });
  it('numeric values', () => {
    expect(verifyNumeric('sqrt(2)', 1.41421356, 1e-6).verdict).toBe('PASS');
    expect(verifyNumeric('pi', 3.15, 1e-3).verdict).toBe('FAIL');
  });
});
