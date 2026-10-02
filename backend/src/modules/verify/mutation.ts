/**
 * CodeConclave — Mutation Testing Engine core (blueprint #23).
 * Scores a test suite by injecting small deterministic bugs (mutants) into a
 * source string and asking the caller-supplied check to kill each one. A
 * mutant the suite does not catch is a hole with a line number — the honest
 * complement to line coverage. Pure functions, zero I/O, zero APIs.
 *
 * Operators are single-token swaps (comparisons, logic, literals, +/-1) so
 * every mutant is syntactically valid by construction for typical TS/JS.
 * Matches inside comments/strings are NOT filtered in this core — callers
 * should scope input to code under test, and survivors must be triaged, not
 * blindly trusted. See module docstring limits.
 */
export interface Mutant {
  id: string;
  line: number;
  operator: string;
  original: string;
  replacement: string;
  mutated: string;
}

interface Operator {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const OPERATORS: Operator[] = [
  { name: 'strict-eq-to-neq', pattern: /===/g, replacement: '!==' },
  { name: 'strict-neq-to-eq', pattern: /!==/g, replacement: '===' },
  { name: 'gt-to-gte', pattern: /(?<![>=])>(?![>=])/g, replacement: '>=' },
  { name: 'lt-to-lte', pattern: /(?<![<=])<(?![<=])/g, replacement: '<=' },
  { name: 'and-to-or', pattern: /&&/g, replacement: '||' },
  { name: 'or-to-and', pattern: /\|\|/g, replacement: '&&' },
  { name: 'true-to-false', pattern: /\btrue\b/g, replacement: 'false' },
  { name: 'false-to-true', pattern: /\bfalse\b/g, replacement: 'true' },
  { name: 'plus-one-to-minus-one', pattern: /\+ 1\b/g, replacement: '- 1' },
  { name: 'minus-one-to-plus-one', pattern: /- 1\b/g, replacement: '+ 1' },
  { name: 'return-true-to-false', pattern: /\breturn true\b/g, replacement: 'return false' },
  { name: 'zero-to-one', pattern: /\breturn 0\b/g, replacement: 'return 1' },
];

export const MUTATION_MAX_MUTANTS = 100;

/** Generate up to `maxMutants` single-point mutants, deterministic order. */
export function generateMutants(source: string, maxMutants = MUTATION_MAX_MUTANTS): Mutant[] {
  const mutants: Mutant[] = [];
  const lines = source.split('\n');
  let n = 0;
  for (const op of OPERATORS) {
    for (let i = 0; i < lines.length && mutants.length < maxMutants; i += 1) {
      const line = lines[i]!;
      op.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = op.pattern.exec(line)) !== null && mutants.length < maxMutants) {
        n += 1;
        const mutatedLine = `${line.slice(0, m.index)}${op.replacement}${line.slice(m.index + m[0].length)}`;
        const mutated = [...lines];
        mutated[i] = mutatedLine;
        mutants.push({
          id: `m${n}`,
          line: i + 1,
          operator: op.name,
          original: m[0],
          replacement: op.replacement,
          mutated: mutated.join('\n'),
        });
        if (m[0].length === 0) break;
      }
    }
  }
  return mutants;
}

export interface MutationScore {
  total: number;
  killed: number;
  survived: number;
  /** 0..1 (1 when no mutants — vacuous, reported explicitly). */
  score: number;
  survivors: Mutant[];
}

/**
 * Score a suite: `kill(mutant)` must return true when the suite catches the
 * mutant (test fails on mutated source). Anchor on the ORIGINAL source first —
 * if the suite fails there too, the score is meaningless (reported, not faked).
 */
export async function scoreMutants(
  mutants: Mutant[],
  kill: (mutant: Mutant) => boolean | Promise<boolean>,
): Promise<MutationScore> {
  const survivors: Mutant[] = [];
  let killed = 0;
  for (const mutant of mutants) {
    if (await kill(mutant)) killed += 1;
    else survivors.push(mutant);
  }
  const total = mutants.length;
  return {
    total,
    killed,
    survived: survivors.length,
    score: total === 0 ? 1 : killed / total,
    survivors,
  };
}
