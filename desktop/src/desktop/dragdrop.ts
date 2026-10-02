/**
 * CodeConClave Desktop — drag & drop file intake.
 * Validation-only in foundation: dropped paths are validated against the active
 * workspace (absolute, inside root, not a symlink escape, not a protected path,
 * size cap) and METADATA is returned. Nothing is copied or executed implicitly.
 */
import type { AttachResult } from '../types.js';
import type { FilesController } from '../local/files-controller.js';

export { validateDropPaths };

async function validateDropPaths(files: FilesController, paths: string[]): Promise<AttachResult> {
  return files.drop(paths);
}