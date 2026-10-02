/**
 * CodeConClave Desktop — undo service (local).
 * Lists edit backups created by the local-agent atomic-write engine and rolls
 * a file back to a chosen snapshot. Rollback is scoped: the target must
 * resolve inside the active workspace and the capability must be granted.
 */
import { rollbackEdit } from '@codeconclave/local-agent/files';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UndoItem, UndoRollbackResult } from '../types.js';
import { WorkspaceManager } from './workspace.js';

export interface UndoStore {
  list(root: string): UndoItem[];
}

export function listBackups(root: string): UndoItem[] {
  const dir = join(root, '.codeconclave-backups');
  if (!existsSync(dir)) return [];
  try {
    const items: UndoItem[] = [];
    for (const f of readdirSync(dir)) {
      // Pattern: <basename>.<hash12>.bak
      const m = /^(.*)\.([0-9a-f]{12})\.bak$/.exec(f);
      if (!m) continue;
      const backupPath = join(dir, f);
      let createdAt = '';
      try {
        createdAt = statSync(backupPath).mtime.toISOString();
      } catch {
        /* skip stat failures */
      }
      items.push({ id: `${m[1]}.${m[2]}`, path: m[1]!, beforeHash: m[2]!, backupPath, createdAt });
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return items;
  } catch {
    return [];
  }
}

export class UndoService {
  constructor(
    private readonly ws: WorkspaceManager,
    private readonly store: UndoStore = { list: listBackups },
  ) {}

  list(): UndoItem[] {
    const grant = this.ws.requireActive('undo.rollback');
    return this.store.list(grant.root);
  }

  rollback(id: string): UndoRollbackResult {
    const grant = this.ws.requireActive('undo.rollback');
    const item = this.store.list(grant.root).find((u) => u.id === id);
    if (!item) return { ok: false, error: 'undo item not found' };
    const targetRel = item.path.replace(/[\\/]+/g, '/');
    const res = rollbackEdit(grant.root, item.backupPath, targetRel);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
}