/**
 * CodeConClave — Quality Intelligence Analyzers (PKG-14).
 * Deterministic, server-authoritative static analyzers for five Group C
 * capabilities:
 *   #6  Code Smell Agent
 *   #7  Concurrent Bug Detector
 *   #8  Memory Leak Hunter
 *   #9  Type Safety Enhancer
 *   #10 Invariant Keeper
 *
 * Honesty model: findings are ADVISORY. A VERIFIED finding is a literal,
 * unambiguous match; a HEURISTIC finding is pattern-based with confidence < 1.
 * No analyzer claims to compile, execute, or prove a bug. Line numbers are
 * derived from the source text when determinable; otherwise null.
 */
import type { AnalysisKind, QualityFinding, FindingSeverity, TruthfulnessState } from './types.js';

export interface AnalyzerInput {
  fileId: string;
  path: string;
  text: string;
}

export type Analyzer = (input: AnalyzerInput, maxFindings: number, startIndex: number) => QualityFinding[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineOf(text: string, charIndex: number): number {
  if (charIndex < 0) return 0;
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function lineMatches(text: string, regex: RegExp): { index: number; m: RegExpExecArray }[] {
  const out: { index: number; m: RegExpExecArray }[] = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, m });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function finding(
  seq: number,
  kind: AnalysisKind,
  ctx: AnalyzerInput,
  rule: string,
  severity: FindingSeverity,
  title: string,
  description: string,
  confidence: number,
  state: TruthfulnessState,
  evidence: string,
  suggestion: string,
  line: number | null,
): QualityFinding {
  return {
    id: `${kind.toLowerCase()}_${seq}`,
    kind,
    filePath: ctx.path,
    fileId: ctx.fileId,
    line,
    rule,
    severity,
    title,
    description,
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
    state,
    evidence,
    suggestion,
  };
}

// ---------------------------------------------------------------------------
// #6 Code Smell Agent
// ---------------------------------------------------------------------------

export const SMELL_RULES = [
  { rule: 'smell-magic-number', re: /(?<![\w$.])\b\d{3,}\b(?![\w$])/, severity: 'LOW' as FindingSeverity },
  { rule: 'smell-single-letter-param', re: /\bfunction\s*\([^)]*\b([a-z])\b\s*[,)]/, severity: 'LOW' as FindingSeverity },
  { rule: 'smell-deep-nesting', re: /\bif\s*\([^)]*\)\s*\{[^}]{0,120}\bif\s*\(/, severity: 'MEDIUM' as FindingSeverity },
  { rule: 'smell-empty-catch', re: /\bcatch\s*\([^)]*\)\s*\{\s*\}/, severity: 'MEDIUM' as FindingSeverity },
  { rule: 'smell-swallowed-error', re: /\bcatch\s*\([^)]*\)\s*\{\s*(?:\/\/|\/\*)\s*(ignore|silent|noop)[\s\S]{0,120}?\}/, severity: 'HIGH' as FindingSeverity },
];

export function analyzeCodeSmell(input: AnalyzerInput, maxFindings: number, startIndex: number): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const { rule, re, severity } of SMELL_RULES) {
    if (out.length >= maxFindings) break;
    for (const { index } of lineMatches(input.text, re)) {
      if (out.length >= maxFindings) break;
      const isVerified = rule === 'smell-empty-catch' || rule === 'smell-magic-number';
      const state: TruthfulnessState = isVerified ? 'VERIFIED' : 'HEURISTIC';
      out.push(
        finding(
          startIndex + out.length,
          'CODE_SMELL',
          input,
          rule,
          severity,
          `Code smell: ${rule.replace('smell-', '')}`,
          `Detected heuristic "${rule.replace('smell-', '')}" pattern in ${input.path}.`,
          state === 'VERIFIED' ? 1 : 0.7,
          state,
          rule,
          'Review and refactor; the finding is advisory and not automatically applied.',
          lineOf(input.text, index),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #7 Concurrent Bug Detector
// ---------------------------------------------------------------------------

export const CONCURRENCY_RULES = [
  {
    rule: 'concurrency-shared-state-async',
    re: /\b(let|var)\s+(\w+)\s*=\s*[^;\n]+;[\s\S]{0,400}(?:await|\.then\()/,
    severity: 'MEDIUM' as FindingSeverity,
  },
  {
    rule: 'concurrency-unhandled-promise-all',
    re: /Promise\.all\(\s*\[/,
    severity: 'LOW' as FindingSeverity,
  },
  {
    rule: 'concurrency-timer-mutation',
    re: /setInterval\(\s*[^,]+,\s*\d+/,
    severity: 'MEDIUM' as FindingSeverity,
  },
  {
    rule: 'concurrency-shared-collection',
    re: /const\s+\w+(Map|Set|Array)\s*=\s*new\s+\1/,
    severity: 'MEDIUM' as FindingSeverity,
  },
];

export function analyzeConcurrency(input: AnalyzerInput, maxFindings: number, startIndex: number): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const { rule, re, severity } of CONCURRENCY_RULES) {
    if (out.length >= maxFindings) break;
    for (const { index } of lineMatches(input.text, re)) {
      if (out.length >= maxFindings) break;
      out.push(
        finding(
          startIndex + out.length,
          'CONCURRENCY',
          input,
          rule,
          severity,
          `Concurrency risk: ${rule.replace('concurrency-', '')}`,
          `Possible race-prone pattern "${rule.replace('concurrency-', '')}" near ${input.path}. Advisory only.`,
          0.55,
          'HEURISTIC',
          rule,
          'Review for data races / ordering; no automatic change is applied.',
          lineOf(input.text, index),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #8 Memory Leak Hunter
// ---------------------------------------------------------------------------

export const LEAK_RULES = [
  {
    rule: 'leak-unbounded-map',
    re: /const\s+\w+\s*=\s*new\s+(Map|Set)\(\s*\);/, // module-scope unbounded Map/Set
    severity: 'MEDIUM' as FindingSeverity,
  },
  {
    rule: 'leak-listener-without-remove',
    re: /addEventListener\(\s*[^)]+\)/,
    severity: 'LOW' as FindingSeverity,
  },
  {
    rule: 'leak-timer-uncleared',
    re: /setInterval\(\s*[^,]+,\s*\d+/,
    severity: 'MEDIUM' as FindingSeverity,
  },
];

export function analyzeMemoryLeak(input: AnalyzerInput, maxFindings: number, startIndex: number): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const { rule, re, severity } of LEAK_RULES) {
    if (out.length >= maxFindings) break;
    for (const { index } of lineMatches(input.text, re)) {
      if (out.length >= maxFindings) break;
      out.push(
        finding(
          startIndex + out.length,
          'MEMORY_LEAK',
          input,
          rule,
          severity,
          `Leak risk: ${rule.replace('leak-', '')}`,
          `Possible unbounded retention "${rule.replace('leak-', '')}" near ${input.path}. Advisory only.`,
          0.5,
          'HEURISTIC',
          rule,
          'Confirm eviction/cleanup exists; no automatic change is applied.',
          lineOf(input.text, index),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #9 Type Safety Enhancer
// ---------------------------------------------------------------------------

export const TYPESAFETY_RULES = [
  { rule: 'typesafety-any', re: /:\s*any\b|as\s+any\b/, severity: 'HIGH' as FindingSeverity },
  { rule: 'typesafety-non-null', re: /\w+!\s*[;.\],)]/, severity: 'MEDIUM' as FindingSeverity },
  { rule: 'typesafety-tsignore', re: /@ts-ignore|@ts-nocheck/, severity: 'MEDIUM' as FindingSeverity },
  { rule: 'typesafety-unknown-call', re: /\.(call|apply)\(\s*(\w+)/, severity: 'LOW' as FindingSeverity },
];

export function analyzeTypeSafety(input: AnalyzerInput, maxFindings: number, startIndex: number): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const { rule, re, severity } of TYPESAFETY_RULES) {
    if (out.length >= maxFindings) break;
    for (const { index } of lineMatches(input.text, re)) {
      if (out.length >= maxFindings) break;
      const isVerified = rule === 'typesafety-tsignore';
      const state: TruthfulnessState = isVerified ? 'VERIFIED' : 'HEURISTIC';
      out.push(
        finding(
          startIndex + out.length,
          'TYPE_SAFETY',
          input,
          rule,
          severity,
          `Type-safety concern: ${rule.replace('typesafety-', '')}`,
          `${state === 'VERIFIED' ? 'Explicit directive' : 'Recommendation for stronger typing'} "${rule.replace('typesafety-', '')}" in ${input.path}.`,
          state === 'VERIFIED' ? 1 : 0.75,
          state,
          rule,
          'Prefer explicit types / typed null-handling; advisory only.',
          lineOf(input.text, index),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #10 Invariant Keeper
// ---------------------------------------------------------------------------

export const INVARIANT_RULES = [
  {
    rule: 'invariant-commented-assert',
    re: /\/\/[^\n]*(\bassert\b|\bif\s*\([^)]*\)\s*throw\b)/,
    severity: 'MEDIUM' as FindingSeverity,
  },
  {
    rule: 'invariant-broad-catch',
    re: /\bcatch\s*\([^)]*\)\s*\{\s*(?:\/\/|\/\*)\s*(ignore|silent|noop)[\s\S]{0,120}?\}/,
    severity: 'HIGH' as FindingSeverity,
  },
  {
    rule: 'invariant-missing-null-check',
    re: /\.(map|forEach|reduce)\(\s*[^)]{0,80}\bundefined\b|[^!]\.[a-z_$]+\s*\)/,
    severity: 'LOW' as FindingSeverity,
  },
];

export function analyzeInvariant(input: AnalyzerInput, maxFindings: number, startIndex: number): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const { rule, re, severity } of INVARIANT_RULES) {
    if (out.length >= maxFindings) break;
    for (const { index } of lineMatches(input.text, re)) {
      if (out.length >= maxFindings) break;
      const isVerified = rule === 'invariant-broad-catch';
      const state: TruthfulnessState = isVerified ? 'VERIFIED' : 'HEURISTIC';
      out.push(
        finding(
          startIndex + out.length,
          'INVARIANT',
          input,
          rule,
          severity,
          `Invariant concern: ${rule.replace('invariant-', '')}`,
          `${state === 'VERIFIED' ? 'Risk to pre/post-condition' : 'Possible missing precondition check'} "${rule.replace('invariant-', '')}" in ${input.path}.`,
          state === 'VERIFIED' ? 0.9 : 0.5,
          state,
          rule,
          'Confirm invariants hold; advisory only.',
          lineOf(input.text, index),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ANALYZERS: Record<AnalysisKind, Analyzer> = {
  CODE_SMELL: analyzeCodeSmell,
  CONCURRENCY: analyzeConcurrency,
  MEMORY_LEAK: analyzeMemoryLeak,
  TYPE_SAFETY: analyzeTypeSafety,
  INVARIANT: analyzeInvariant,
};

export const KIND_DESCRIPTIONS: Record<AnalysisKind, string> = {
  CODE_SMELL: 'Deterministic code-smell heuristics (magic numbers, nesting, swallowed errors).',
  CONCURRENCY: 'Heuristic race/ordering risk detection over shared state and timers.',
  MEMORY_LEAK: 'Heuristic unbounded-retention and listener/timer cleanup detection.',
  TYPE_SAFETY: 'Literal + heuristic detection of unsound typing constructs.',
  INVARIANT: 'Heuristic detection of weakened/ignored pre- and post-conditions.',
};

export const ALL_KINDS: AnalysisKind[] = ['CODE_SMELL', 'CONCURRENCY', 'MEMORY_LEAK', 'TYPE_SAFETY', 'INVARIANT'];
