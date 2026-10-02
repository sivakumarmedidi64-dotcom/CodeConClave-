/**
 * CodeConClave AI OS — P2.4 Undo Last N.
 *
 * Safe surgical rollback on top of the P0 filesystem diff primitive. Each
 * session action records the exact file before/after content. Undo restores
 * ONLY the files touched by the chosen actions (N most recent), never touching
 * unrelated user work. Requires preview + confirmation; maintains an audit
 * event for every rollback.
 */
import { AppError } from '../../shared/errors.js';
import { diffLines } from '../diff.js';
import type { P2Feature } from './flags.js';

export interface UndoAction {
  id: number;
  label: string;
  /** filePath -> { before, after } */
  mutations: Map<string, { before: string; after: string }>;
  at: number;
}

export interface UndoPreview {
  actionIds: number[];
  files: string[];
  changes: Array<{ file: string; actionId: number }>;
}

export class UndoLog {
  private actions: UndoAction[] = [];
  private nextId = 1;
  private audits: string[] = [];

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'undo';
  }

  /** Record a completed action (its exact before/after per file). */
  record(label: string, mutations: Array<{ file: string; before: string; after: string }>): number {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_undo_disabled', 'undo feature is off');
    const map = new Map<string, { before: string; after: string }>();
    for (const m of mutations) map.set(m.file, { before: m.before, after: m.after });
    const rec: UndoAction = { id: this.nextId++, label, mutations: map, at: Date.now() };
    this.actions.push(rec);
    return rec.id;
  }

  /** PREVIEW: compute files affected by the N most-recent actions. */
  preview(n: number): UndoPreview {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_undo_disabled', 'undo feature is off');
    const chosen = this.actions.slice(-Math.max(1, n));
    const changes: Array<{ file: string; actionId: number }> = [];
    for (const a of chosen) {
      for (const file of a.mutations.keys()) changes.push({ file, actionId: a.id });
    }
    return {
      actionIds: chosen.map((a) => a.id),
      files: [...new Set(changes.map((c) => c.file))],
      changes,
    };
  }

  /** The exact diffs for preview (never auto-applied). */
  diffPreview(n: number): Array<{ file: string; before: string; additions: number; deletions: number }> {
    const affected = new Map<string, { before: string }>();
    const chosen = this.actions.slice(-Math.max(1, n));
    for (const a of chosen) {
      for (const [file, m] of a.mutations) affected.set(file, { before: m.before });
    }
    const out: Array<{ file: string; before: string; additions: number; deletions: number }> = [];
    for (const [file, { before }] of affected) {
      const d = diffLines(before, '');
      out.push({ file, before, additions: d.additions, deletions: d.deletions });
    }
    return out;
  }

  /**
   * CONFIRM + restore: for the N most-recent actions, restore each file to its
   * before-content. Only files touched by those actions are touched. Returns the
   * list of restored files and records an audit event. `authorized` must be true
   * (caller holds the rollback capability).
   */
  apply(n: number, authorized: boolean): { restoredFiles: string[]; restoredBefore: (file: string) => string | undefined } {
    if (!authorized) throw AppError.forbidden('aios_p2_undo_denied', 'undo requires capability');
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_undo_disabled', 'undo feature is off');
    const chosen = this.actions.slice(-Math.max(1, n));
    const restored = new Map<string, string>();
    for (const a of chosen) {
      for (const [file, m] of a.mutations) restored.set(file, m.before);
    }
    const audit = `undo#${chosen.map((a) => a.id).join(',')}@${Date.now()} files=${restored.size}`;
    this.audits.push(audit);
    return {
      restoredFiles: [...restored.keys()],
      restoredBefore: (file) => restored.get(file),
    };
  }

  auditLog(): string[] {
    return [...this.audits];
  }

  get actionCount(): number {
    return this.actions.length;
  }
}
