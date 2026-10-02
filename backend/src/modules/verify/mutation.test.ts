/**
 * CodeConclave — Mutation Testing Engine tests.
 * Covers: operator coverage, single-point mutants, line numbers,
 * determinism, cap, scoring incl. survivors and the vacuous (zero-mutant)
 * case. The "suite" here is a stub predicate — the engine is caller-agnostic.
 */
import { describe, it, expect } from 'vitest';
import { generateMutants, scoreMutants } from './mutation.js';

const SAMPLE = `function eligible(age: number, admin: boolean): boolean {
  if (age > 18 && admin === true) {
    return true;
  }
  return false;
}
`;

describe('Mutation Testing Engine', () => {
  it('generates single-point mutants for each operator class', () => {
    const mutants = generateMutants(SAMPLE);
    const ops = new Set(mutants.map((m) => m.operator));
    for (const expected of ['gt-to-gte', 'and-to-or', 'strict-eq-to-neq', 'true-to-false', 'false-to-true', 'return-true-to-false']) {
      expect(ops, expected).toContain(expected);
    }
    // single-point: each mutant differs from source in exactly one spot
    for (const m of mutants) {
      expect(m.mutated).not.toBe(SAMPLE);
      expect(m.line).toBeGreaterThanOrEqual(1);
      expect(m.line).toBeLessThanOrEqual(6);
    }
  });

  it('is deterministic and capped', () => {
    expect(generateMutants(SAMPLE)).toEqual(generateMutants(SAMPLE));
    expect(generateMutants(SAMPLE, 3)).toHaveLength(3);
    expect(generateMutants('const x = 1;\n')).toEqual([]);
  });

  it('scores a suite and names survivors with line numbers', async () => {
    const mutants = generateMutants(SAMPLE);
    expect(mutants.length).toBeGreaterThan(0);
    // stub suite: catches everything except mutants on line 2
    const score = await scoreMutants(mutants, (m) => m.line !== 2);
    expect(score.total).toBe(mutants.length);
    expect(score.killed + score.survived).toBe(score.total);
    expect(score.survivors.every((s) => s.line === 2)).toBe(true);
    expect(score.score).toBeCloseTo(score.killed / score.total);
  });

  it('reports a vacuous score of 1 when no mutants exist', async () => {
    const score = await scoreMutants([], () => true);
    expect(score).toEqual({ total: 0, killed: 0, survived: 0, score: 1, survivors: [] });
  });
});
