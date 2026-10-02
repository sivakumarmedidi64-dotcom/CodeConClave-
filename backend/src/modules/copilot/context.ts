/**
 * CodeConClave — PKG-24 AI Developer Copilot — bounded context assembly.
 *
 * Builds the bounded, tagged context a copilot operation reasons over:
 *   - MEMORY  : relevant persistent memory (PKG-23 buildCodingContext)
 *   - EVIDENCE: current-code/current-runtime evidence (diagnostics, runtime,
 *               deployment, selected source) — never overridden by memory
 *   - RELATED : related files / symbols
 *
 * Context is bounded (bytes + item counts) so we never dump the repository into
 * a model. All deps are injectable so this module is testable without a DB.
 */
import type { ContextItem } from '../memorycoding/codingContext.js';
import { COPILOT_CONFIG } from './config.js';
import { sanitizeCapturedContent, dataGuardNote } from './security.js';

export interface CopilotContextOptions {
  projectId: string;
  file?: string | null;
  selection?: { line?: number; col?: number; text?: string } | null;
  symbol?: string | null;
  error?: string | null;
  taskId?: string | null;
}

export interface CopilotContext {
  projectId: string;
  activeFile: string | null;
  selection: { line?: number; col?: number; text?: string } | null;
  memory: Array<{ kind: string; label: string; detail: string; confidence: number; ref?: string | null }>;
  code: Array<{ path: string; snippet: string; nearby: boolean; truncated: boolean }>;
  relatedFiles: string[];
  diagnostics: Array<{ file?: string; kind?: string; summary: string }>;
  runtimeEvidence: Array<{ label: string; detail: string; confidence: number; ref?: string | null }>;
  injectionCandidates: Array<{ ref?: string; detail: string }>;
  guardNote: string;
  byteLength: number;
  truncated: boolean;
}

/** Dependencies that can be injected for tests. */
export interface CopilotContextDeps {
  buildCodingContext(userId: string, opts: {
    projectId: string; file?: string | null; symbol?: string | null; error?: string | null; taskId?: string | null;
  }): Promise<ContextItem[]>;
  readSourceFile(projectId: string, path: string): Promise<string | null>;
  detectAffectedFiles(projectId: string, path: string): Promise<string[]>;
  fileDiagnostics(projectId: string, path: string): Promise<Array<{ kind?: string; summary: string }>>;
  runtimeEvidence(userId: string, projectId: string): Promise<Array<{ label: string; detail: string; confidence: number; ref?: string | null }>>;
}

/** Default dependency wiring against the real modules. */
export function defaultCopilotContextDeps(): CopilotContextDeps {
  return {
    async buildCodingContext(userId, opts) {
      const { buildCodingContext } = await import('../memorycoding/codingContext.js');
      return buildCodingContext(userId, opts);
    },
    async readSourceFile(projectId, path) {
      const { readFileEntry } = await import('../codeworkspace/fs.js');
      try {
        const entry = await readFileEntry(projectId, path);
        return entry?.content ?? null;
      } catch {
        return null;
      }
    },
    async detectAffectedFiles(projectId, path) {
      const { detectAffectedFiles: df } = await import('../codeworkspace/related.js');
      try {
        const rel = await df(projectId, path);
        return (rel ?? []).map((a) => a.path);
      } catch {
        return [];
      }
    },
    async fileDiagnostics(projectId, path) {
      const { getFileDiagnostics } = await import('../codeworkspace/diagnostics.js');
      try {
        const d = await getFileDiagnostics('copilot', projectId, path);
        return d.findings.map((f) => ({
          kind: f.severity,
          summary: f.message,
        }));
      } catch {
        return [];
      }
    },
    async runtimeEvidence(userId, projectId) {
      const { runtimeMemory } = await import('../memorycoding/runtimeMemory.js');
      return runtimeMemory(userId, projectId, COPILOT_CONFIG.maxEvidenceItems);
    },
  };
}

function measure(pieces: string | string[]): number {
  const joined = typeof pieces === 'string' ? pieces : pieces.join('\n');
  return Buffer.byteLength(joined, 'utf8');
}

const CODE_BUDGET = Math.floor(COPILOT_CONFIG.maxContextBytes * 0.5);
const CLEAR_BUDGET = COPILOT_CONFIG.maxContextBytes - CODE_BUDGET;

/**
 * Assemble the bounded copilot context for a project.
 * Memory is advisory and never overrides current evidence.
 */
export async function buildCopilotContext(
  userId: string,
  opts: CopilotContextOptions,
  deps: CopilotContextDeps = defaultCopilotContextDeps(),
): Promise<CopilotContext> {
  const [memoryItems, relatedFiles, runtimeEvidence, selected] = await Promise.all([
    deps.buildCodingContext(userId, {
      projectId: opts.projectId,
      file: opts.file ?? null,
      symbol: opts.symbol ?? null,
      error: opts.error ?? null,
      taskId: opts.taskId ?? null,
    }),
    opts.file ? deps.detectAffectedFiles(opts.projectId, opts.file) : Promise.resolve<string[]>([]),
    deps.runtimeEvidence(userId, opts.projectId),
    opts.file ? deps.readSourceFile(opts.projectId, opts.file) : Promise.resolve<string | null>(null),
  ]);

  const memory = memoryItems.slice(0, COPILOT_CONFIG.maxMemoryItems).map((m) => ({
    kind: m.kind,
    label: m.label,
    detail: m.detail,
    confidence: m.confidence,
    ref: m.ref ?? null,
  }));

  const code: CopilotContext['code'] = [];
  if (opts.file) {
    if (selected) {
      // Priority: selected text, else a bounded leading slice of the active file.
      const seed = opts.selection?.text && opts.selection.text.length > 0 ? opts.selection.text : selected;
      const snippet = seed.substring(0, CODE_BUDGET);
      code.push({ path: opts.file, snippet, nearby: false, truncated: seed.length > CODE_BUDGET });
    }
  }

  const diagnostics = opts.file ? await deps.fileDiagnostics(opts.projectId, opts.file).catch(() => []) : [];

  const clearPieces: string[] = [];
  const memPieces = memory.map((m) => `[${m.kind}] ${m.label}: ${m.detail}`);
  const relPieces = relatedFiles.slice(0, COPILOT_CONFIG.maxRelatedFiles);
  const evPieces = runtimeEvidence.map((e) => `[${e.label}] ${e.detail}`);
  clearPieces.push(
    `project=${opts.projectId} file=${opts.file ?? '(none)'} symbol=${opts.symbol ?? '(none)'} error=${opts.error ? opts.error.substring(0, 300) : '(none)'}`,
    `memory(${memPieces.length}):\n${memPieces.join('\n')}`,
    `related(${relPieces.length}): ${relPieces.join(', ')}`,
    `runtimeEvidence(${evPieces.length}):\n${evPieces.join('\n')}`,
  );
  let clearText = clearPieces.join('\n');
  if (measure(clearText) > CLEAR_BUDGET) {
    const trunc = Buffer.from(clearText, 'utf8').subarray(0, CLEAR_BUDGET).toString('utf8');
    clearText = trunc + '\n…[truncated]';
  }

  const injectionCandidates = code
    .map((c) => ({ ref: c.path, detail: c.snippet }))
    .filter((c) => /ignore previous/i.test(c.detail))
    .slice(0, 4);

  const total = measure([clearText, ...code.map((c) => c.snippet)]);

  return {
    projectId: opts.projectId,
    activeFile: opts.file ?? null,
    selection: opts.selection ?? null,
    memory,
    code,
    relatedFiles: relatedFiles.slice(0, COPILOT_CONFIG.maxRelatedFiles),
    diagnostics,
    runtimeEvidence: runtimeEvidence.slice(0, COPILOT_CONFIG.maxEvidenceItems),
    injectionCandidates,
    guardNote: dataGuardNote(),
    byteLength: total,
    truncated: total > COPILOT_CONFIG.maxContextBytes,
  };
}
