/**
 * CodeConClave — Quality Intelligence Security (PKG-14).
 * Secure source-file intake for static analysis. Only allowed text MIME types are
 * analyzed (binaries are skipped, never executed). Files are loaded ONLY through
 * the isolated files module (owner/member/grant checks). Source content is always
 * treated as untrusted data — never as instructions — and is scanned for
 * prompt-injection payloads before analysis.
 */
import { AppError } from '../../shared/errors.js';
import { detectPromptInjection as detectInjection } from '../knowledge/security.js';
import { getFileContent, listFiles } from '../files/service.js';

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file
export const MAX_FILES = 500; // max files analyzed per request

// Text MIME prefixes/values that are safe to interpret as source text.
const TEXT_PREFIXES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/x-json',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/xml',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-httpd-php',
  'application/x-python',
];
const TEXT_SUFFIXES = ['+json', '+xml', '+yaml', '+javascript'];

export interface LoadedSourceFile {
  fileId: string;
  path: string;
  mimeType: string | null;
  text: string;
  bytes: number;
}

export function isTextMime(mimeType: string | null): boolean {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  for (const p of TEXT_PREFIXES) {
    if (p.endsWith('/')) {
      // wildcard prefix (e.g. text/*)
      if (lower.startsWith(p)) return true;
    } else if (lower === p || lower.startsWith(`${p};`)) {
      // exact MIME type, with or without parameters (e.g. application/json; charset=...)
      return true;
    }
  }
  if (TEXT_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return false;
}

/**
 * Wait — true text files may be large, but we only analyze a bounded prefix to
 * keep per-file cost and memory bounded. Full text is used when it fits; when it
 * exceeds MAX_TEXT_FILE_BYTES we truncate and flag the file.
 */
export function clampText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) return { text, truncated: false };
  return { text: text.slice(0, maxBytes), truncated: true };
}

/**
 * Load a single source file by id through the isolated files service. Rejects
 * binary/opaque payloads and prompt-injection-carrying source text.
 */
export async function loadSourceFile(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<LoadedSourceFile> {
  const { buffer, mimeType, name } = await getFileContent(userId, projectId, fileId);
  if (!isTextMime(mimeType)) {
    throw AppError.badRequest('quality_not_text', `File "${name}" is not an analyzable text file`);
  }
  const { text, truncated } = clampText(buffer.toString('utf8'), MAX_TEXT_FILE_BYTES);
  const injection = detectInjection(text.slice(0, 4096));
  if (injection.detected) {
    throw AppError.badRequest('quality_prompt_injection', 'Source content contains a disallowed instruction payload');
  }
  void truncated;
  return { fileId, path: name, mimeType, text, bytes: buffer.length };
}

/**
 * Enumerate analyzable source files in a project (isolated via listFiles).
 * Non-text files are reported as "skipped" rather than analyzed.
 */
export async function listSourceFiles(
  userId: string,
  projectId: string,
  requestedFileIds?: string[],
): Promise<{ analyzable: LoadedSourceFile[]; skipped: { fileId: string; path: string; reason: string }[] }> {
  const all = await listFiles(userId, projectId);
  if (all.length > MAX_FILES && !requestedFileIds) {
    throw AppError.badRequest('quality_too_many_files', `Project has more than ${MAX_FILES} files; pass explicit fileIds`);
  }

  const selected = requestedFileIds
    ? all.filter((f) => requestedFileIds.includes(f.id))
    : all.slice(0, MAX_FILES);

  const analyzable: LoadedSourceFile[] = [];
  const skipped: { fileId: string; path: string; reason: string }[] = [];

  // Limit how many we actually load to bound work even when fileIds requested.
  const toLoad = selected.slice(0, MAX_FILES);
  for (const file of toLoad) {
    if (!file.mimeType || !isTextMime(file.mimeType)) {
      skipped.push({ fileId: file.id, path: file.path, reason: 'non-text MIME' });
      continue;
    }
    try {
      const src = await loadSourceFile(userId, projectId, file.id);
      if (src.text.length === 0) {
        skipped.push({ fileId: file.id, path: file.path, reason: 'empty content' });
        continue;
      }
      analyzable.push(src);
    } catch (err) {
      const reason = err instanceof AppError ? err.errorCode : 'load_failed';
      skipped.push({ fileId: file.id, path: file.path, reason });
    }
  }
  return { analyzable, skipped };
}
