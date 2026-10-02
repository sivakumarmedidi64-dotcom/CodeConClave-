/**
 * CodeConClave — PKG-22 Advanced Code Workspace — HEURISTIC symbol intelligence.
 * Regex-based, compile-free symbol scanning for outline, go-to-definition,
 * find-references, import/export relationships, and call relationships.
 * Capability state is always HEURISTIC — never claimed as a full LSP/compiler.
 */
import { AppError } from '../../shared/errors.js';
import { listFilePaths, readFileEntry } from './fs.js';
import { workspaceEnabled } from './config.js';

// ---------------------------------------------------------------- types
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'export' | 'import' | 'method' | 'enum';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
  exportDefault?: boolean;
  exported?: boolean;
  static?: boolean;
  abstract?: boolean;
  params?: string;
  returnType?: string;
}

export interface DefinitionResult {
  symbol: string;
  found: boolean;
  file: string | null;
  line: number | null;
  col: number | null;
  kind: SymbolKind | null;
  context: string | null;
}

export interface ReferenceResult {
  symbol: string;
  count: number;
  references: Array<{ file: string; line: number; text: string; col: number }>;
}

export interface ImportRelation {
  from: string;
  to: string;
  symbols: string[];
  line: number;
}

export interface OutlineResult {
  file: string;
  symbols: SymbolInfo[];
}

// ---------------------------------------------------------------- regex patterns for HEURISTIC scanning
const FN_RE = /^export\s+(default\s+)?(async\s+)?function\s+(\w+)(\s*<[^>]*>)?\s*\(([^)]*)\)\s*(:\s*[^{]+)?/gm;
const CLASS_RE = /^export\s+(abstract\s+)?class\s+(\w+)(\s+extends\s+(\w+))?(Implements\s+(.+))?\s*\{/gm;
const INTERFACE_RE = /^export\s+(interface|type|enum)\s+(\w+)(\s+extends\s+[^{]+)?\s*[:{]/gm;
const CONST_RE = /^export\s+(const|let|var)\s+(\w+)\s*[:=]/gm;
const IMPORT_RE = /^import\s+(?:(\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+)?['"](.+?)['"]/gm;
const CALL_RE = /\b(\w+)\s*\(/gm;
const METHOD_RE = /^\s+(static\s+)?(abstract\s+)?(\w+)\s*\(([^)]*)\)\s*(:\s*[^{]+)?/gm;

function extractSymbols(projectId: string, relPath: string, content: string): SymbolInfo[] {
  const syms: SymbolInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    FN_RE.lastIndex = 0;
    m = FN_RE.exec(line);
    if (m) {
      syms.push({ name: m[3]!, kind: 'function', file: relPath, line: i + 1, col: line.indexOf('function') + 1, exportDefault: Boolean(m[1]), exported: true, params: m[5] || undefined, returnType: m[6]?.trim().slice(1)?.trim() || undefined });
      continue;
    }

    CLASS_RE.lastIndex = 0;
    m = CLASS_RE.exec(line);
    if (m) {
      syms.push({ name: m[2]!, kind: 'class', file: relPath, line: i + 1, col: line.indexOf('class') + 1, abstract: Boolean(m[1]), exported: true });
      // scan methods inside class body
      for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
        const ml = lines[j]!;
        if (ml.match(/^\};?\s*$/)) break;
        const mm = METHOD_RE.exec(ml);
        if (mm && !mm[2] && mm[3] !== 'constructor') {
          syms.push({ name: mm[3]!, kind: 'method', file: relPath, line: j + 1, col: ml.indexOf(mm[3]!) + 1, static: Boolean(mm[1]), params: mm[4] || undefined, returnType: mm[5]?.trim().slice(1)?.trim() || undefined });
        }
      }
      continue;
    }

    INTERFACE_RE.lastIndex = 0;
    m = INTERFACE_RE.exec(line);
    if (m) {
      syms.push({ name: m[2]!, kind: (m[1] === 'type' ? 'type' : m[1] === 'enum' ? 'enum' : 'interface'), file: relPath, line: i + 1, col: line.indexOf(m[1]!) + 1, exported: true });
      continue;
    }

    CONST_RE.lastIndex = 0;
    m = CONST_RE.exec(line);
    if (m) {
      syms.push({ name: m[2]!, kind: 'const' as SymbolKind, file: relPath, line: i + 1, col: line.indexOf(m[2]!) + 1, exported: true });
      continue;
    }
  }
  return syms;
}

// ---------------------------------------------------------------- public API

export async function getOutline(projectId: string, relPath: string): Promise<OutlineResult | null> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const file = await readFileEntry(projectId, relPath);
  if (!file || file.binary) return null;
  return { file: relPath, symbols: extractSymbols(projectId, relPath, file.content) };
}

export async function findDefinition(projectId: string, symbol: string, relPath?: string): Promise<DefinitionResult> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const paths = relPath ? [relPath] : await listFilePaths(projectId);
  if (!paths) return { symbol, found: false, file: null, line: null, col: null, kind: null, context: null };

  for (const p of paths) {
    const file = await readFileEntry(projectId, p);
    if (!file || file.binary) continue;
    const syms = extractSymbols(projectId, p, file.content);
    const hit = syms.find((s) => s.name === symbol);
    if (hit) {
      const lines = file.content.split('\n');
      return { symbol, found: true, file: p, line: hit.line, col: hit.col, kind: hit.kind, context: lines[hit.line - 1] ?? null };
    }
  }
  return { symbol, found: false, file: null, line: null, col: null, kind: null, context: null };
}

export async function findReferences(projectId: string, symbol: string, _relPath?: string): Promise<ReferenceResult> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const paths = await listFilePaths(projectId);
  if (!paths) return { symbol, count: 0, references: [] };

  const refs: ReferenceResult['references'] = [];
  const symRe = new RegExp(`\\b${symbol}\\b`, 'g');

  for (const p of paths) {
    const file = await readFileEntry(projectId, p);
    if (!file || file.binary) continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      symRe.lastIndex = 0;
      if (symRe.test(lines[i]!)) {
        refs.push({ file: p, line: i + 1, text: lines[i]!.slice(0, 200), col: lines[i]!.indexOf(symbol) + 1 });
      }
      if (refs.length >= 500) break;
    }
    if (refs.length >= 500) break;
  }
  return { symbol, count: refs.length, references: refs };
}

export async function findImportRelations(projectId: string, relPath: string): Promise<ImportRelation[]> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const file = await readFileEntry(projectId, relPath);
  if (!file || file.binary) return [];
  const imports: ImportRelation[] = [];
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    IMPORT_RE.lastIndex = 0;
    const m = IMPORT_RE.exec(lines[i]!);
    if (m) {
      imports.push({ from: relPath, to: m[2]!, symbols: [], line: i + 1 });
    }
  }
  return imports;
}