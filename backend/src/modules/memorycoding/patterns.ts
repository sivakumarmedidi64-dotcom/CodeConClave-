/**
 * CodeConClave — PKG-23 Development Pattern Memory (C-4 Cross-Cowork Pattern
 * Learning).
 *
 * A pattern must NOT become a rule from a single observation. It only becomes
 * confidently usable with SUFFICIENT EVIDENCE (repeated observation) or EXPLICIT
 * user/team confirmation. Confidence is derived from evidence/confirm/reject
 * counts (see patternConfidence). Patterns are suggestions — never auto-applied,
 * never allowed to override current repository evidence.
 */
import {
  upsertPattern,
  bumpPattern,
  supersedePattern,
  listPatterns,
  patternConfidence,
  type PatternRow,
} from './codingRecords.js';

export interface PatternInput {
  projectId?: string | null;
  name: string;
  description: string;
  category?: string | null;
  source?: string;
}

export async function recordPattern(userId: string, input: PatternInput): Promise<PatternRow> {
  return upsertPattern(userId, {
    projectId: input.projectId ?? null,
    name: input.name,
    description: input.description,
    category: input.category ?? null,
    source: input.source ?? 'OBSERVED',
  });
}

/** Increment evidence for an already-recorded pattern (repeated observation). */
export async function addPatternEvidence(userId: string, patternId: string): Promise<PatternRow | null> {
  const rows = await listPatterns(userId);
  const p = rows.find((x) => x.id === patternId);
  if (!p) return null;
  return upsertPattern(userId, {
    projectId: p.project_id,
    name: p.name,
    description: p.description,
    category: p.category,
    source: p.source,
    evidenceCount: p.evidence_count + 1,
  });
}

/** Explicit user confirmation — the strongest signal a pattern is a rule. */
export async function confirmPattern(userId: string, patternId: string): Promise<PatternRow | null> {
  return bumpPattern(userId, patternId, 'confirm');
}

/** Explicit rejection — reduces confidence and can supersede the pattern. */
export async function rejectPattern(userId: string, patternId: string): Promise<PatternRow | null> {
  return bumpPattern(userId, patternId, 'reject');
}

export async function retirePattern(userId: string, patternId: string): Promise<void> {
  await supersedePattern(userId, patternId);
}

export async function listDevPatterns(userId: string, projectId?: string | null): Promise<PatternRow[]> {
  return listPatterns(userId, projectId ?? null);
}

/** Only patterns above a usability confidence threshold are suggested. */
export function usablePatterns(patterns: PatternRow[], threshold = 0.3): PatternRow[] {
  return patterns.filter((p) => p.confidence >= threshold);
}

export { patternConfidence };
