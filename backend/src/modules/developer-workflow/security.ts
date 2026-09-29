/**
 * CodeConClave — Developer Workflow Security (PKG-17).
 * Secure, isolated source-file intake for static developer-workflow analysis.
 * Reuses the quality-intelligence containment rules (text-MIME allowlist +
 * prompt-injection screening via the isolated files service); source is treated
 * as untrusted data and binaries are skipped — never executed.
 */
import {
  isTextMime as qualityIsTextMime,
  listSourceFiles as qualityListSourceFiles,
  loadSourceFile as qualityLoadSourceFile,
  MAX_FILES,
  MAX_TEXT_FILE_BYTES,
} from '../quality-intelligence/security.js';
import type { LoadedSourceFile as QualityLoadedSourceFile } from '../quality-intelligence/security.js';

export const MAX_TEXT_FILE_BYTES_REPORT = MAX_TEXT_FILE_BYTES;
export const MAX_FILES_REPORT = MAX_FILES;

export function isTextMime(mimeType: string | null): boolean {
  return qualityIsTextMime(mimeType);
}

export async function listSourceFilesSafe(
  userId: string,
  projectId: string,
  requestedFileIds?: string[],
): Promise<{ analyzable: QualityLoadedSourceFile[]; skipped: { fileId: string; path: string; reason: string }[] }> {
  return qualityListSourceFiles(userId, projectId, requestedFileIds);
}

export async function loadSourceFileSafe(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<QualityLoadedSourceFile> {
  return qualityLoadSourceFile(userId, projectId, fileId);
}