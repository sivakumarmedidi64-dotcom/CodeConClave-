/**
 * CodeConClave — "Beyond agentic" systems: shared project-source loading.
 *
 * Every Beyond system measures the user's REAL project files. Files are read
 * only through the isolated files service (owner checks, text-only, size cap),
 * and the project's own .codeconclaveignore / .aiignore is honoured
 * (constitution Article 4). The measurements never send file text to an AI;
 * the one AI path (Council opinions) shields the text itself.
 * Large projects are measured on their first MAX_FILES text files and the
 * result says so — never silently.
 */
import { getFileContent, listFiles } from '../files/service.js';
import { clampText, isTextMime, MAX_FILES, MAX_TEXT_FILE_BYTES, type LoadedSourceFile } from '../quality-intelligence/security.js';
import { AppError } from '../../shared/errors.js';
import { isIgnored, loadProjectIgnore } from '../projects/instructions.js';

export interface ProjectSources {
  files: LoadedSourceFile[];
  /** Text files that exist but were not measured (cap, ignore file, unreadable). */
  skipped: { path: string; reason: string }[];
  /** True when the project had more text files than one measurement covers. */
  capped: boolean;
}

/**
 * One project file as text. Same owner check and text-only rule as the quality
 * loader, but without its prompt-injection screen: that screen looks for HTML
 * and script patterns (`on…=`, `eval(`) that ordinary code is full of, so it
 * would silently drop real files from a measurement.
 */
export async function loadBeyondFile(userId: string, projectId: string, fileId: string): Promise<LoadedSourceFile> {
  const { buffer, mimeType, name } = await getFileContent(userId, projectId, fileId);
  if (!isTextMime(mimeType)) throw AppError.badRequest('quality_not_text', `File "${name}" is not an analyzable text file`);
  const { text } = clampText(buffer.toString('utf8'), MAX_TEXT_FILE_BYTES);
  return { fileId, path: name, mimeType, text, bytes: buffer.length };
}

/** Text files of a project, oldest-to-newest path order, bounded. */
export async function loadProjectSources(userId: string, projectId: string, opts: { onlyFileIds?: string[]; max?: number } = {}): Promise<ProjectSources> {
  const max = Math.min(opts.max ?? MAX_FILES, MAX_FILES);
  const [all, ignore] = await Promise.all([listFiles(userId, projectId), loadProjectIgnore(userId, projectId)]);
  const skipped: ProjectSources['skipped'] = [];
  const candidates = all.filter((f) => {
    if (f.isDirectory) return false;
    if (opts.onlyFileIds && !opts.onlyFileIds.includes(f.id)) return false;
    if (!isTextMime(f.mimeType)) return false;
    if (isIgnored(f.path, ignore.rules)) {
      skipped.push({ path: f.path, reason: `ignored by ${ignore.file ?? 'ignore file'}` });
      return false;
    }
    return true;
  });
  const capped = candidates.length > max;
  const files: LoadedSourceFile[] = [];
  for (const f of candidates.slice(0, max)) {
    try {
      const src = await loadBeyondFile(userId, projectId, f.id);
      if (src.text.length > 0) files.push(src);
    } catch (err) {
      skipped.push({ path: f.path, reason: err instanceof Error ? err.message.slice(0, 120) : 'unreadable' });
    }
  }
  if (capped) skipped.push({ path: `(${candidates.length - max} more files)`, reason: `only the first ${max} text files are measured` });
  return { files, skipped, capped };
}

/** File extension (lower case, no dot). */
export function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1]!.toLowerCase() : '';
}

/** Source-code files (what the code systems measure); docs/config are not code. */
export function isCodePath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|swift|c|cc|cpp|h|hpp|scala|vue|svelte|sql|sh)$/i.test(path);
}
