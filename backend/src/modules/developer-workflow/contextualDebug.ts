/**
 * CodeConClave — #41 Contextual Debugging (PKG-17).
 * From a user-supplied error signature/message, scan the workspace source and
 * surface the most contextually relevant clues: files that mention the symbol,
 * likely failure sites, and hypothesized causes. Read-only, heuristic, advisory.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { ContextualDebugReport, DebugClue, TruthfulnessState } from './types.js';

function tokenizeError(err: string): string[] {
  const cleaned = (err || '').replace(/`/g, ' ').replace(/[^A-Za-z0-9_ .-]/g, ' ');
  return Array.from(new Set(cleaned.split(/\s+/).filter((t) => t.length >= 3 && t.length <= 40)));
}

function findClues(
  files: LoadedSourceFile[],
  tokens: string[],
  raw: string,
): DebugClue[] {
  const clues: DebugClue[] = [];
  const state: TruthfulnessState = 'HEURISTIC';
  const seen = new Set<string>();

  for (const f of files) {
    if (clues.length >= 20) break;
    const lowered = f.text.toLowerCase();
    const hits = tokens.filter((t) => lowered.includes(t.toLowerCase()));
    if (hits.length === 0) continue;

    const key = `${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Find the first line matching any token.
    const lines = f.text.split('\n');
    let line: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (tokens.some((t) => lines[i]?.toLowerCase().includes(t.toLowerCase()))) {
        line = i + 1;
        break;
      }
    }

    const likelyThrow = /throw|error|assert|reject|undefined|null|except|panic/i.test(f.text);
    const cause = likelyThrow
      ? 'file contains explicit error/throw paths — inspect this site for the failing branch'
      : 'file is contextually related to the error tokens — inspect usage';

    clues.push({
      id: newId(PREFIX.DEVWORKFLOW_DEBUG),
      filePath: f.path,
      line,
      label: `${f.path}${line != null ? `:${line}` : ''}`,
      symptom: `matches ${hits.length} token(s): ${hits.slice(0, 4).join(', ')}`,
      hypothesizedCause: cause,
      recommendation: `Open ${f.path}${line != null ? ` near line ${line}` : ''} and inspect the referenced identifiers.`,
      state,
    });
  }

  if (clues.length === 0) {
    clues.push({
      id: newId(PREFIX.DEVWORKFLOW_DEBUG),
      filePath: '',
      line: null,
      label: '(no match)',
      symptom: `no source file mentioned the provided error signature "${raw}"`,
      hypothesizedCause: 'unclear — error may originate in an external dependency or runtime',
      recommendation: 'Search commit history and stack traces for the failing call path.',
      state,
    });
  }
  return clues;
}

export async function buildContextualDebugReport(
  userId: string,
  projectId: string,
  errorSignature: string,
): Promise<ContextualDebugReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const tokens = tokenizeError(errorSignature);
  const clues = findClues(analyzable, tokens, errorSignature);
  const matchType = clues[0] && clues[0].filePath ? (clues.length > 1 ? 'HEURISTIC' : 'EXACT') : 'NONE';

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    errorSignature,
    matchType,
    clues,
    totalClues: clues.length,
    state: 'HEURISTIC',
    limitations: [
      'Token-matched heuristic over static source — no runtime stack trace is used.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Hypothesized causes are advisory; always confirm against the real failing context.',
    ],
  };
}