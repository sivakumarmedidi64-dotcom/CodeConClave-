/**
 * CodeConClave — Code Search Oracle (V4A).
 * Extends existing search module with semantic, symbol, and relationship search.
 * Reuses existing indexing/vector/search infrastructure.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { globalSearch, SearchFilters, SearchHit } from '../search/service.js';
import { semanticSearch, retrieveMemoriesForPrompt } from '../memory/service.js';
import { globalSearch as searchFiles } from '../search/service.js';
import { logger } from '../../shared/logger.js';

export interface SymbolSearchResult {
  projectId: string;
  query: string;
  symbols: CodeSymbol[];
  total: number;
}

export interface CodeSymbol {
  id: string;
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum' | 'method';
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docComment?: string;
  references: SymbolReference[];
  definitionLocation?: { filePath: string; line: number };
}

export interface SymbolReference {
  filePath: string;
  line: number;
  context: string;
  referenceType: 'call' | 'import' | 'type' | 'assignment' | 'destructure';
}

export interface ImplementationSearchResult {
  projectId: string;
  interfaceName: string;
  implementations: Implementation[];
  total: number;
}

export interface Implementation {
  id: string;
  className: string;
  filePath: string;
  implementsInterface: string;
  methods: ImplementedMethod[];
}

export interface ImplementedMethod {
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
}

export interface DependencySearchResult {
  projectId: string;
  target: string;
  dependents: DependentItem[];
  dependencies: DependencyItem[];
}

export interface DependentItem {
  filePath: string;
  symbol: string;
  referenceType: 'import' | 'call' | 'type' | 'extends';
  line: number;
  context: string;
}

export interface DependencyItem {
  filePath: string;
  importedFrom: string;
  symbols: string[];
  line: number;
}

export interface CallGraphResult {
  projectId: string;
  rootSymbol: string;
  maxDepth: number;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

export interface CallGraphNode {
  id: string;
  name: string;
  filePath: string;
  type: 'function' | 'method' | 'constructor';
}

export interface CallGraphEdge {
  from: string;
  to: string;
  callType: 'direct' | 'async' | 'conditional' | 'loop';
  line: number;
}

export interface SimilarCodeResult {
  projectId: string;
  queryCode: string;
  matches: SimilarCodeMatch[];
}

export interface SimilarCodeMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  similarity: number;
  matchedCode: string;
  reason: string;
}

export interface TodoSearchResult {
  projectId: string;
  todos: TodoItem[];
  total: number;
}

export interface TodoItem {
  filePath: string;
  line: number;
  type: 'TODO' | 'FIXME' | 'HACK' | 'BUG' | 'OPTIMIZE' | 'NOTE';
  text: string;
  context: string;
  author?: string;
  createdAt?: Date;
}

export interface DeadCodeCandidate {
  projectId: string;
  candidates: DeadCodeItem[];
}

export interface DeadCodeItem {
  filePath: string;
  symbolName: string;
  symbolType: 'function' | 'class' | 'variable' | 'export';
  reason: 'never_called' | 'never_imported' | 'exported_not_used' | 'dead_branch';
  confidence: number;
  evidence: string;
}

export interface RefactoringImpactResult {
  projectId: string;
  targetSymbol: string;
  impactRadius: ImpactItem[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedFilesAffected: number;
  estimatedTestFilesAffected: number;
}

export interface ImpactItem {
  filePath: string;
  symbol: string;
  impactType: 'direct_call' | 'type_dependency' | 'inheritance' | 'test' | 'transitive';
  confidence: number;
  path: string[];
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function searchSymbols(
  userId: string,
  projectId: string,
  query: string,
  options: { type?: CodeSymbol['type']; includeReferences?: boolean; limit?: number } = {}
): Promise<SymbolSearchResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const fileSymbols = extractSymbols(f.content, file.path as string);
    for (const sym of fileSymbols) {
      const key = `${sym.filePath}:${sym.name}:${sym.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (query && !sym.name.toLowerCase().includes(query.toLowerCase())) continue;
      if (options.type && sym.type !== options.type) continue;

      if (options.includeReferences) {
        sym.references = await findReferences(userId, projectId, sym, files);
      }

      symbols.push(sym);
      if (symbols.length >= (options.limit ?? 50)) break;
    }
    if (symbols.length >= (options.limit ?? 50)) break;
  }

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'symbol_search',
    detail: { projectId, query, results: symbols.length },
  });

  return { projectId, query, symbols, total: symbols.length };
}

function extractSymbols(content: string, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split('\n');

  const patterns = [
    { regex: /function\s+(\w+)\s*\(([^)]*)\)/g, type: 'function' as const },
    { regex: /const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g, type: 'function' as const },
    { regex: /async\s+function\s+(\w+)\s*\(([^)]*)\)/g, type: 'function' as const },
    { regex: /class\s+(\w+)(?:\s+extends\s+\w+)?/g, type: 'class' as const },
    { regex: /interface\s+(\w+)/g, type: 'interface' as const },
    { regex: /type\s+(\w+)\s*=/g, type: 'type' as const },
    { regex: /enum\s+(\w+)/g, type: 'enum' as const },
    { regex: /const\s+(\w+)\s*=\s*[^=]/g, type: 'variable' as const },
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
    const name = match[1]!;
      const lineStart = getLineNumber(content, match.index);
      const lineEnd = type === 'function' ? getFunctionEndLine(content, match.index) : lineStart + 10;
      const signature = match[0].slice(0, 200);

      const docComment = extractDocComment(lines, lineStart - 1);

      symbols.push({
        id: `sym_${filePath}_${name}_${lineStart}`,
        name,
        type,
        filePath: '',
        startLine: lineStart,
        endLine: lineEnd,
        signature,
        docComment,
        references: [],
      });
    }
  }

  return symbols.map(s => ({ ...s, filePath }));
}

function getFunctionEndLine(content: string, startIndex: number): number {
  let braceCount = 0;
  let inFunction = false;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') { braceCount++; inFunction = true; }
    else if (content[i] === '}') { braceCount--; if (inFunction && braceCount === 0) return getLineNumber(content, i); }
  }
  return getLineNumber(content, startIndex) + 20;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extractDocComment(lines: string[], lineIndex: number): string | undefined {
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('/**') || line.startsWith('///')) {
      let comment = line;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!.trim();
        if (prev.startsWith('*') || prev.startsWith('/**') || prev.startsWith('///')) {
          comment = prev + '\n' + comment;
        } else break;
      }
      return comment;
    }
    if (line && !line.startsWith('*') && !line.startsWith('/')) break;
  }
  return undefined;
}

async function findReferences(userId: string, projectId: string, symbol: CodeSymbol, files: Awaited<ReturnType<typeof searchFiles>>): Promise<SymbolReference[]> {
  const references: SymbolReference[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.includes(symbol.name)) {
        const refType = classifyReference(line, symbol);
        if (refType) {
          references.push({
            filePath: file.path as string,
            line: i + 1,
            context: line.trim().slice(0, 200),
            referenceType: refType,
          });
        }
      }
    }
  }

  return references.slice(0, 20);
}

function classifyReference(line: string, symbol: CodeSymbol): SymbolReference['referenceType'] | null {
  if (line.includes(`import`) && line.includes(symbol.name)) return 'import';
  if (line.includes(`${symbol.name}(`)) return 'call';
  if (line.includes(`${symbol.name} as`) || line.includes(`: ${symbol.name}`)) return 'type';
  if (line.includes(`${symbol.name} =`) || line.includes(`= ${symbol.name}`)) return 'assignment';
  if (line.includes(`{ ${symbol.name} }`) || line.includes(`{${symbol.name}}`)) return 'destructure';
  return null;
}

export async function findImplementations(
  userId: string,
  projectId: string,
  interfaceName: string
): Promise<ImplementationSearchResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const implementations: Implementation[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    if (f.content.includes(`implements ${interfaceName}`) || f.content.includes(`implements ${interfaceName},`)) {
      const classMatch = f.content.match(/class\s+(\w+)/);
      if (classMatch && classMatch[1]) {
        const methods = extractImplementedMethods(f.content, interfaceName);
        implementations.push({
          id: `impl_${file.path}_${classMatch[1]}`,
          className: classMatch[1],
          filePath: file.path as string,
          implementsInterface: interfaceName,
          methods,
        });
      }
    }
  }

  return { projectId, interfaceName, implementations, total: implementations.length };
}

function extractImplementedMethods(content: string, interfaceName: string): ImplementedMethod[] {
  const methods: ImplementedMethod[] = [];
  const methodPattern = /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/g;
  let match;
  while ((match = methodPattern.exec(content)) !== null) {
    methods.push({
      name: match[1]!,
      signature: `${match[1]!}(${match[2]!})`,
      startLine: getLineNumber(content, match.index),
      endLine: getFunctionEndLine(content, match.index),
    });
  }
  return methods;
}

export async function searchDependencies(
  userId: string,
  projectId: string,
  target: string,
  direction: 'dependents' | 'dependencies' | 'both' = 'both'
): Promise<DependencySearchResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const dependents: DependentItem[] = [];
  const dependencies: DependencyItem[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    if (f.content.includes(target)) {
      const lines = f.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line.includes(`import`) && line.includes(target)) {
          dependents.push({
            filePath: file.path as string,
            symbol: target,
            referenceType: 'import',
            line: i + 1,
            context: line.trim().slice(0, 200),
          });
        }
        if (line.includes(`${target}(`)) {
          dependents.push({
            filePath: file.path as string,
            symbol: target,
            referenceType: 'call',
            line: i + 1,
            context: line.trim().slice(0, 200),
          });
        }
        if (line.includes(`extends ${target}`) || line.includes(`implements ${target}`)) {
          dependents.push({
            filePath: file.path as string,
            symbol: target,
            referenceType: 'extends',
            line: i + 1,
            context: line.trim().slice(0, 200),
          });
        }
      }
    }

    const importMatches = f.content.matchAll(/import\s+.*\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      const importedFrom = match[1];
      const matchIndex = match.index;
      if (importedFrom && importedFrom.includes(target)) {
        dependencies.push({
          filePath: file.path as string,
          importedFrom,
          symbols: [target],
          line: getLineNumber(f.content, matchIndex ?? 0),
        });
      }
    }
  }

  return { projectId, target, dependents, dependencies };
}

export async function getCallGraph(
  userId: string,
  projectId: string,
  rootSymbol: string,
  maxDepth: number = 3
): Promise<CallGraphResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];
  const nodeMap = new Map<string, CallGraphNode>();

  const findFunction = async (name: string): Promise<{ filePath: string; content: string } | null> => {
    for (const file of files.results) {
      if (!file.projectId || !file.path) continue;
      const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
        db
          .query<{ path: string; content: string }>(
            `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
            [projectId, file.path as string],
          )
          .then((r) => r.rows[0] ?? null),
      );
      if (!analysis || !analysis.content) continue;
      if (analysis.content.includes(`function ${name}`) || analysis.content.includes(`const ${name} =`)) {
        return { filePath: analysis.path, content: analysis.content };
      }
    }
    return null;
  };

  const visited = new Set<string>();
  const queue: { name: string; filePath: string; depth: number }[] = [{ name: rootSymbol, filePath: '', depth: 0 }];

  while (queue.length > 0 && visited.size < 100) {
    const current = queue.shift()!;
    if (visited.has(current.name)) continue;
    visited.add(current.name);

    const func = await findFunction(current.name);
    if (!func) continue;

    const nodeId = `${current.name}@${func.filePath}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        name: current.name,
        filePath: func.filePath,
        type: 'function',
      });
      nodes.push(nodeMap.get(nodeId)!);
    }

    if (current.depth >= maxDepth) continue;

    const calledFunctions = extractFunctionCalls(func.content);
    for (const called of calledFunctions) {
      if (!nodeMap.has(`${called}@${func.filePath}`)) {
        const calledFunc = await findFunction(called);
        if (calledFunc) {
          queue.push({ name: called, filePath: calledFunc.filePath, depth: current.depth + 1 });
        }
      }
      edges.push({
        from: nodeId,
        to: `${called}@${func.filePath}`,
        callType: classifyCallType(func.content, called),
        line: findCallLine(func.content, called),
      });
    }
  }

  return { projectId, rootSymbol, maxDepth, nodes, edges };
}

function extractFunctionCalls(content: string): string[] {
  const calls: string[] = [];
  const pattern = /(\w+)\s*\(/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1]!;
    if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof'].includes(name)) {
      calls.push(name);
    }
  }
  return [...new Set(calls)];
}

function classifyCallType(content: string, callee: string): CallGraphEdge['callType'] {
  const beforeCall = content.slice(0, content.indexOf(`${callee}(`));
  if (beforeCall.includes('await ')) return 'async';
  if (beforeCall.includes('if') || beforeCall.includes('?')) return 'conditional';
  if (beforeCall.includes('for') || beforeCall.includes('while')) return 'loop';
  return 'direct';
}

function findCallLine(content: string, callee: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`${callee}(`)) return i + 1;
  }
  return 1;
}

export async function findSimilarCode(
  userId: string,
  projectId: string,
  queryCode: string,
  options: { threshold?: number; limit?: number } = {}
): Promise<SimilarCodeResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const matches: SimilarCodeMatch[] = [];
  const threshold = options.threshold ?? 0.6;

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const similarity = calculateSimilarity(queryCode, f.content);
    if (similarity >= threshold) {
      matches.push({
        filePath: file.path as string,
        startLine: 1,
        endLine: f.content.split('\n').length,
        similarity: Math.round(similarity * 100) / 100,
        matchedCode: f.content.slice(0, 500),
        reason: 'High structural similarity',
      });
    }
  }

  matches.sort((a, b) => b.similarity - a.similarity);

  return { projectId, queryCode, matches: matches.slice(0, options.limit ?? 10) };
}

function calculateSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function tokenize(code: string): string[] {
  return code
    .replace(/[{}()[\];,]/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(t => t.length > 2 && !/^\d+$/.test(t))
    .map(t => t.toLowerCase());
}

export async function searchTodos(
  userId: string,
  projectId: string,
  options: { type?: TodoItem['type']; limit?: number } = {}
): Promise<TodoSearchResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const todos: TodoItem[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const lines = f.content.split('\n');
    const todoPattern = /\/\/(?:\s*@?\w+)?\s*(TODO|FIXME|HACK|BUG|OPTIMIZE|NOTE)\s*[:\-]?\s*(.+)/gi;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let match;
      while ((match = todoPattern.exec(line)) !== null) {
        const type = match[1] as TodoItem['type'];
        if (options.type && type !== options.type) continue;

        const todoText = match[2]?.trim() ?? '';
        todos.push({
          filePath: file.path as string,
          line: i + 1,
          type,
          text: todoText,
          context: lines.slice(Math.max(0, i - 2), i + 3).join('\n'),
        });
      }
    }
  }

  return { projectId, todos: todos.slice(0, options.limit ?? 100), total: todos.length };
}

export async function findDeadCode(userId: string, projectId: string): Promise<DeadCodeCandidate> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const candidates: DeadCodeItem[] = [];
  const allSymbols = new Map<string, { filePath: string; type: string; exported: boolean; used: boolean }>();

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const symbols = extractSymbols(f.content, file.path as string);
    for (const sym of symbols) {
      const key = `${sym.name}@${file.path}`;
      allSymbols.set(key, {
        filePath: file.path as string,
        type: sym.type,
        exported: f.content.includes(`export ${sym.type} ${sym.name}`) || f.content.includes(`export { ${sym.name} }`),
        used: false,
      });
    }
  }

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (db) =>
      db
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    for (const [key, sym] of allSymbols) {
      const symName = key.split('@')[0]!;
      if (f.content.includes(sym.type === 'function' ? `${symName}(` : symName)) {
        sym.used = true;
      }
    }
  }

  for (const [key, sym] of allSymbols) {
    if (!sym.used) {
      let reason: DeadCodeItem['reason'] = 'never_called';
      if (sym.exported) reason = 'exported_not_used';
      candidates.push({
        filePath: sym.filePath,
        symbolName: key.split('@')[0]!,
        symbolType: sym.type as DeadCodeItem['symbolType'],
        reason,
        confidence: sym.exported ? 0.7 : 0.9,
        evidence: `${sym.exported ? 'Exported' : 'Internal'} ${sym.type} never referenced`,
      });
    }
  }

  return { projectId, candidates: candidates.slice(0, 50) };
}

export async function analyzeRefactoringImpact(
  userId: string,
  projectId: string,
  targetSymbol: string
): Promise<RefactoringImpactResult> {
  await assertProjectAccess(userId, projectId);

  const depResult = await searchDependencies(userId, projectId, targetSymbol, 'dependents');
  const impactItems: ImpactItem[] = [];

  for (const dep of depResult.dependents) {
    impactItems.push({
      filePath: dep.filePath,
      symbol: dep.symbol,
      impactType: classifyImpactType(dep.referenceType),
      confidence: 0.8,
      path: [targetSymbol, dep.symbol],
    });
  }

  const riskLevel = calculateRefactoringRisk(impactItems);
  const estimatedFiles = new Set(impactItems.map(i => i.filePath)).size;
  const estimatedTestFiles = await estimateTestFilesAffected(userId, projectId, impactItems);

  return {
    projectId,
    targetSymbol,
    impactRadius: impactItems,
    riskLevel,
    estimatedFilesAffected: estimatedFiles,
    estimatedTestFilesAffected: estimatedTestFiles,
  };
}

function classifyImpactType(refType: string): ImpactItem['impactType'] {
  switch (refType) {
    case 'call': return 'direct_call';
    case 'import': return 'type_dependency';
    case 'extends': return 'inheritance';
    default: return 'transitive';
  }
}

function calculateRefactoringRisk(impacts: ImpactItem[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const directCalls = impacts.filter(i => i.impactType === 'direct_call').length;
  const inheritance = impacts.filter(i => i.impactType === 'inheritance').length;
  const highConfidence = impacts.filter(i => i.confidence > 0.7).length;

  if (inheritance > 0 || directCalls > 10) return 'CRITICAL';
  if (directCalls > 5 || highConfidence > 15) return 'HIGH';
  if (impacts.length > 10) return 'MEDIUM';
  return 'LOW';
}

async function estimateTestFilesAffected(userId: string, projectId: string, impacts: ImpactItem[]): Promise<number> {
  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  let count = 0;
  for (const impact of impacts) {
    const filePath = impact.filePath as string;
    const testFiles = files.results.filter(f =>
      f.category === 'test' && (f.path as string) &&
      ((f.path as string).includes(filePath.split('/').slice(0, -1).join('/')) ||
       (f.path as string).includes(`test_${filePath.split('/').pop()}`) ||
       (f.path as string).includes(`${filePath.split('/').pop()?.replace('.ts', '')}.test`))
    );
    count += testFiles.length;
  }
  return count;
}