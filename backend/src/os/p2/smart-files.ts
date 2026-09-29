/**
 * CodeConClave AI OS — P2.9 Smart File Picker.
 *
 * Ranks candidate files in a workspace against a natural-language query/task
 * using lexical + structural signals (name tokens, path depth, extension
 * weight, protected-status penalty). It is workspace/context aware and never
 * proposes a protected file for editing without an explicit approval. Pure
 * scoring — any write/edit still goes through the stop-rule policy.
 */
import { AppError } from '../../shared/errors.js';
import type { P2Feature } from './flags.js';

export interface FileCandidate {
  path: string;
  score: number;
  reasons: string[];
  isProtected: boolean;
}

export interface WorkspaceIndex {
  files: readonly string[];
}

export class SmartFilePicker {
  constructor(
    private feature: () => P2Feature | null,
    private isProtected: (path: string) => boolean,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'smart_files';
  }

  /**
   * Rank the workspace files by relevance to `query`. `recentlyTouched` boosts
   * files the session already worked on. Protected files are still returned
   * (so the user can request approval) but flagged and never ranked above
   * unprotected peers unnecessarily.
   */
  pick(ws: WorkspaceIndex, opts: { query: string; limit?: number; recentlyTouched?: string[] }): FileCandidate[] {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_smartfiles_disabled', 'smart file picker is off');
    const limit = opts.limit ?? 8;
    const q = tokenize(opts.query.toLowerCase());
    const recent = new Set((opts.recentlyTouched ?? []).map((p) => p.toLowerCase()));
    const scored: FileCandidate[] = ws.files.map((path) => {
      const lower = path.toLowerCase();
      const toks = tokenize(lower);
      let score = 0;
      const reasons: string[] = [];
      // token overlap
      let overlap = 0;
      for (const t of q) if (toks.has(t)) overlap += 1;
      score += overlap * 10;
      if (overlap > 0) reasons.push('name match');
      // extension weight for common code files
      if (q.size > 0 && /\.(ts|js|tsx|jsx|py|go|rs|json|yml|yaml)$/.test(lower)) {
        score += 2;
        reasons.push('code file');
      }
      // shallower paths rank higher (more likely the intended target)
      const depth = (path.match(/\//g)?.length ?? 0);
      score += Math.max(0, 6 - depth);
      // recently touched boost
      if (recent.has(lower)) {
        score += 15;
        reasons.push('recently touched');
      }
      const isProt = this.isProtected(path);
      if (isProt) {
        score -= 20;
        reasons.push('isProtected');
      }
      return { path, score, reasons, isProtected: isProt };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).filter((c) => c.score > 0);
  }
}

function tokenize(s: string): Set<string> {
  return new Set(s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
}

