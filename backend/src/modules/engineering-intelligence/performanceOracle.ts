/**
 * CodeConClave — Performance Oracle (V4A).
 * Uses existing performance data where available.
 * Measurements: MEASURED | ESTIMATED | UNKNOWN — never invents numbers.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { globalSearch } from '../search/service.js';
import { listTasks } from '../execution/tasks.js';
import { logger } from '../../shared/logger.js';

export type MeasurementSource = 'MEASURED' | 'ESTIMATED' | 'UNKNOWN';

export interface ComplexityAnalysis {
  projectId: string;
  functions: FunctionComplexity[];
  summary: ComplexitySummary;
}

export interface FunctionComplexity {
  filePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  linesOfCode: number;
  nestingDepth: number;
  source: MeasurementSource;
}

export interface ComplexitySummary {
  totalFunctions: number;
  avgComplexity: number;
  maxComplexity: number;
  highComplexityCount: number;
  estimatedRefactorHours: number;
}

export interface SlowFunction {
  filePath: string;
  functionName: string;
  estimatedDurationMs: number;
  source: MeasurementSource;
  reason: string;
  optimizationHints: string[];
}

export interface DatabaseQueryRisk {
  filePath: string;
  query: string;
  estimatedCost: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskFactors: string[];
  source: MeasurementSource;
  suggestedIndexes: string[];
}

export interface NPlusOneDetection {
  filePath: string;
  pattern: string;
  loopContext: string;
  estimatedQueries: number;
  source: MeasurementSource;
  fixSuggestion: string;
}

export interface CachingOpportunity {
  filePath: string;
  functionName: string;
  computationType: 'pure' | 'idempotent' | 'expensive_io';
  estimatedSavingsMs: number;
  source: MeasurementSource;
  cacheKeySuggestion: string;
}

export interface RepeatedComputation {
  filePath: string;
  functionName: string;
  computationDescription: string;
  occurrenceCount: number;
  source: MeasurementSource;
  deduplicationSuggestion: string;
}

export interface ApiLatencyRisk {
  endpoint: string;
  method: string;
  estimatedP99Ms: number;
  source: MeasurementSource;
  bottlenecks: string[];
  scalingAdvice: string[];
}

export interface PerformanceRegression {
  projectId: string;
  baselineDate: Date;
  currentDate: Date;
  regressions: RegressionItem[];
  improvements: ImprovementItem[];
}

export interface RegressionItem {
  metric: string;
  baseline: number;
  current: number;
  changePercent: number;
  source: MeasurementSource;
  likelyCause: string;
}

export interface ImprovementItem {
  metric: string;
  baseline: number;
  current: number;
  changePercent: number;
  source: MeasurementSource;
}

export interface PerformanceReport {
  projectId: string;
  complexity: ComplexityAnalysis;
  slowFunctions: SlowFunction[];
  dbQueryRisks: DatabaseQueryRisk[];
  nPlusOnes: NPlusOneDetection[];
  cachingOpportunities: CachingOpportunity[];
  repeatedComputations: RepeatedComputation[];
  apiLatencyRisks: ApiLatencyRisk[];
  summary: PerformanceSummary;
}

export interface PerformanceSummary {
  overallScore: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  estimatedOptimizationHours: number;
  topRecommendations: string[];
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function generatePerformanceReport(userId: string, projectId: string): Promise<PerformanceReport> {
  await assertProjectAccess(userId, projectId);

  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 300 });
  const tasks = await listTasks(userId, projectId);

  const complexity = await analyzeComplexity(userId, projectId, files);
  const slowFunctions = await findSlowFunctions(userId, projectId, files, tasks);
  const dbQueryRisks = await analyzeDbQueries(userId, projectId, files);
  const nPlusOnes = await detectNPlusOnes(userId, projectId, files);
  const cachingOpps = await findCachingOpportunities(userId, projectId, files);
  const repeatedComps = await findRepeatedComputations(userId, projectId, files);
  const apiRisks = await analyzeApiLatency(userId, projectId, files);

  const summary = buildSummary(complexity, slowFunctions, dbQueryRisks, nPlusOnes, cachingOpps, repeatedComps, apiRisks);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'performance_report',
    detail: { projectId, overallScore: summary.overallScore, critical: summary.criticalIssues },
  });

  return {
    projectId,
    complexity,
    slowFunctions,
    dbQueryRisks,
    nPlusOnes,
    cachingOpportunities: cachingOpps,
    repeatedComputations: repeatedComps,
    apiLatencyRisks: apiRisks,
    summary,
  };
}

async function readFileContent(userId: string, projectId: string, filePath: string): Promise<{ path: string; content: string } | null> {
  return withTenant<{ path: string; content: string } | null>(userId, (db) =>
    db
      .query<{ path: string; content: string }>(
        `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
        [projectId, filePath],
      )
      .then((r) => r.rows[0] ?? null),
  );
}

async function analyzeComplexity(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<ComplexityAnalysis> {
  const functions: FunctionComplexity[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const content = analysis.content;
    const lines = content.split('\n');

    const functionPatterns = [
      { regex: /function\s+(\w+)\s*\([^)]*\)\s*\{/g, type: 'function' },
      { regex: /const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, type: 'arrow' },
      { regex: /async\s+function\s+(\w+)\s*\([^)]*\)/g, type: 'async' },
    ];

    for (const { regex, type } of functionPatterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const funcName = match[1]!;
        const funcStart = match.index;
        const funcLines = getFunctionLines(content, funcStart);
        const funcContent = extractFunctionBody(content, funcStart);

        functions.push({
          filePath: file.path as string,
          functionName: funcName,
          startLine: getLineNumber(content, funcStart),
          endLine: getLineNumber(content, funcStart) + funcLines,
          cyclomaticComplexity: calculateCyclomaticComplexity(funcContent),
          cognitiveComplexity: calculateCognitiveComplexity(funcContent),
          linesOfCode: funcLines,
          nestingDepth: calculateMaxNesting(funcContent),
          source: 'ESTIMATED' as MeasurementSource,
        });
      }
    }
  }

  const summary: ComplexitySummary = {
    totalFunctions: functions.length,
    avgComplexity: functions.length > 0 ? Math.round(functions.reduce((a, b) => a + b.cyclomaticComplexity, 0) / functions.length) : 0,
    maxComplexity: functions.length > 0 ? Math.max(...functions.map(f => f.cyclomaticComplexity)) : 0,
    highComplexityCount: functions.filter(f => f.cyclomaticComplexity > 20).length,
    estimatedRefactorHours: Math.round(functions.filter(f => f.cyclomaticComplexity > 20).length * 2.5),
  };

  return { projectId, functions, summary };
}

async function findSlowFunctions(
  userId: string,
  projectId: string,
  files: Awaited<ReturnType<typeof globalSearch>>,
  tasks: Awaited<ReturnType<typeof listTasks>>
): Promise<SlowFunction[]> {
  const slow: SlowFunction[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const funcs = extractAllFunctions(f.content);
    for (const func of funcs) {
      const reasons: string[] = [];
      let estimatedMs = 0;

      if (func.cyclomaticComplexity > 30) {
        reasons.push('High cyclomatic complexity');
        estimatedMs += func.cyclomaticComplexity * 0.5;
      }
      if (func.nestingDepth > 5) {
        reasons.push('Deep nesting');
        estimatedMs += func.nestingDepth * 2;
      }
      if (func.linesOfCode > 150) {
        reasons.push('Large function');
        estimatedMs += func.linesOfCode * 0.1;
      }
      if (func.content.includes('await') && func.content.match(/await/g)!.length > 5) {
        reasons.push('Multiple sequential awaits');
        estimatedMs += 50;
      }
      if (func.content.includes('.find') || func.content.includes('.filter')) {
        reasons.push('Potential O(n) operations in loop');
        estimatedMs += 20;
      }

      if (reasons.length > 0 && estimatedMs > 10) {
        slow.push({
          filePath: file.path as string,
          functionName: func.name,
          estimatedDurationMs: Math.round(estimatedMs),
          source: 'ESTIMATED' as MeasurementSource,
          reason: reasons.join('; '),
          optimizationHints: generateOptimizationHints(func, reasons),
        });
      }
    }
  }

  return slow.sort((a, b) => b.estimatedDurationMs - a.estimatedDurationMs).slice(0, 20);
}

interface ExtractedFunction {
  name: string;
  content: string;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  linesOfCode: number;
  nestingDepth: number;
}

function extractAllFunctions(content: string): ExtractedFunction[] {
  const funcs: ExtractedFunction[] = [];
  const patterns = [
    /function\s+(\w+)\s*\([^)]*\)\s*\{/g,
    /const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /async\s+function\s+(\w+)\s*\([^)]*\)/g,
  ];

  for (const { regex } of patterns.map(p => ({ regex: p }))) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]!;
      const start = match.index!;
      const lines = getFunctionLines(content, start);
      const body = extractFunctionBody(content, start);
      funcs.push({
        name,
        content: body,
        cyclomaticComplexity: calculateCyclomaticComplexity(body),
        cognitiveComplexity: calculateCognitiveComplexity(body),
        linesOfCode: lines,
        nestingDepth: calculateMaxNesting(body),
      });
    }
  }
  return funcs;
}

function getFunctionLines(content: string, startIndex: number): number {
  let braceCount = 0;
  let inFunction = false;
  let lines = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') { braceCount++; inFunction = true; }
    else if (content[i] === '}') { braceCount--; if (inFunction && braceCount === 0) break; }
    if (inFunction && content[i] === '\n') lines++;
  }
  return lines;
}

function extractFunctionBody(content: string, startIndex: number): string {
  let braceCount = 0;
  let inFunction = false;
  let start = -1;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') { braceCount++; if (!inFunction) { inFunction = true; start = i + 1; } }
    else if (content[i] === '}') { braceCount--; if (inFunction && braceCount === 0) return content.slice(start, i); }
  }
  return '';
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function calculateCyclomaticComplexity(content: string): number {
  const patterns = [/\bif\b/g, /\belse if\b/g, /\bwhile\b/g, /\bfor\b/g, /\bcase\b/g, /\bcatch\b/g, /\b\?\b/g, /\b&&\b/g, /\b\|\|\b/g];
  let complexity = 1;
  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) complexity += matches.length;
  }
  return complexity;
}

function calculateCognitiveComplexity(content: string): number {
  let complexity = 0;
  let nestingLevel = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{') nestingLevel++;
    else if (content[i] === '}') nestingLevel = Math.max(0, nestingLevel - 1);
    else if (/\b(if|else|while|for|catch)\b/.test(content.slice(i, i + 10))) {
      complexity += 1 + nestingLevel;
    }
  }
  return complexity;
}

function calculateMaxNesting(content: string): number {
  let maxDepth = 0, currentDepth = 0;
  for (const char of content) {
    if ('{([ '.includes(char)) { currentDepth++; maxDepth = Math.max(maxDepth, currentDepth); }
    else if ('})] '.includes(char)) currentDepth = Math.max(0, currentDepth - 1);
  }
  return maxDepth;
}

function generateOptimizationHints(func: { content: string; cyclomaticComplexity: number; nestingDepth: number }, reasons: string[]): string[] {
  const hints: string[] = [];
  if (reasons.some(r => r.includes('cyclomatic'))) hints.push('Extract decision logic into strategy pattern or lookup table');
  if (reasons.some(r => r.includes('nesting'))) hints.push('Use guard clauses to flatten conditionals');
  if (reasons.some(r => r.includes('Large'))) hints.push('Split into smaller single-responsibility functions');
  if (reasons.some(r => r.includes('await'))) hints.push('Parallelize independent async operations with Promise.all');
  if (reasons.some(r => r.includes('O(n)'))) hints.push('Consider indexing or caching for repeated lookups');
  return hints;
}

async function analyzeDbQueries(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<DatabaseQueryRisk[]> {
  const risks: DatabaseQueryRisk[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const sqlPatterns = [
      { pattern: /SELECT\s+\*\s+FROM\s+(\w+)/gi, type: 'select_star' },
      { pattern: /SELECT.*FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=/gi, type: 'where_eq' },
      { pattern: /JOIN\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi, type: 'join' },
      { pattern: /ORDER\s+BY\s+(\w+)(?:\s+DESC)?\s+LIMIT\s+(\d+)/gi, type: 'order_limit' },
    ];

    for (const { pattern, type } of sqlPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(f.content)) !== null) {
        const query = match[0];
        const riskFactors: string[] = [];
        let cost: DatabaseQueryRisk['estimatedCost'] = 'LOW';

        if (type === 'select_star') { riskFactors.push('SELECT * fetches all columns'); cost = 'MEDIUM'; }
        if (type === 'where_eq' && !f.content.includes('INDEX')) { riskFactors.push('WHERE on non-indexed column suspected'); cost = 'HIGH'; }
        if (type === 'join' && !f.content.includes('INDEX')) { riskFactors.push('JOIN without visible index hints'); cost = 'MEDIUM'; }
        if (type === 'order_limit' && !f.content.includes('INDEX')) { riskFactors.push('ORDER BY LIMIT without index'); cost = 'HIGH'; }

        if (riskFactors.length > 0) {
          risks.push({
            filePath: file.path as string,
            query: query.slice(0, 500),
            estimatedCost: cost,
            riskFactors,
            source: 'ESTIMATED' as MeasurementSource,
            suggestedIndexes: generateIndexSuggestions(query, type),
          });
        }
      }
    }
  }

  return risks.slice(0, 30);
}

function generateIndexSuggestions(query: string, type: string): string[] {
  const suggestions: string[] = [];
  const whereMatch = query.match(/WHERE\s+(\w+)\s*=/i);
  if (whereMatch) suggestions.push(`CREATE INDEX ON table(${whereMatch[1]})`);
  const orderMatch = query.match(/ORDER\s+BY\s+(\w+)/i);
  if (orderMatch) suggestions.push(`CREATE INDEX ON table(${orderMatch[1]})`);
  const joinMatch = query.match(/JOIN\s+(\w+)\s+ON\s+\w+\.(\w+)/i);
  if (joinMatch) suggestions.push(`CREATE INDEX ON ${joinMatch[1]}(${joinMatch[2]})`);
  return suggestions;
}

async function detectNPlusOnes(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<NPlusOneDetection[]> {
  const detections: NPlusOneDetection[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (/(for|forEach|map)\s*\(/.test(line)) {
        const nextLines = lines.slice(i + 1, i + 10).join('\n');
        if (!nextLines) continue;
        if (/\.find\(|\.findOne\(|\.get\(|query\(|select\(/.test(nextLines)) {
          detections.push({
            filePath: file.path as string,
            pattern: line.trim().slice(0, 100),
            loopContext: nextLines.slice(0, 200),
            estimatedQueries: 10,
            source: 'ESTIMATED' as MeasurementSource,
            fixSuggestion: 'Batch fetch with WHERE IN (...) or use DataLoader pattern',
          });
        }
      }
    }
  }

  return detections.slice(0, 20);
}

async function findCachingOpportunities(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<CachingOpportunity[]> {
  const opportunities: CachingOpportunity[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const funcs = extractAllFunctions(f.content);
    for (const func of funcs) {
      let type: CachingOpportunity['computationType'] | null = null;
      let savings = 0;

      if (func.content.includes('fetch') || func.content.includes('axios') || func.content.includes('http')) {
        type = 'expensive_io'; savings = 200;
      } else if (func.content.includes('compute') || func.content.includes('calculate') || func.content.includes('transform')) {
        type = 'pure'; savings = 50;
      } else if (func.content.includes('SELECT') || func.content.includes('query')) {
        type = 'idempotent'; savings = 100;
      }

      if (type && savings > 20) {
        opportunities.push({
          filePath: file.path as string,
          functionName: func.name,
          computationType: type,
          estimatedSavingsMs: savings,
          source: 'ESTIMATED' as MeasurementSource,
          cacheKeySuggestion: `${func.name}:${type}:{{args}}`,
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.estimatedSavingsMs - a.estimatedSavingsMs).slice(0, 15);
}

async function findRepeatedComputations(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<RepeatedComputation[]> {
  const computations: RepeatedComputation[] = [];
  const computationMap = new Map<string, { count: number; locations: string[]; description: string }>();

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const funcs = extractAllFunctions(f.content);
    for (const func of funcs) {
      const desc = summarizeComputation(func.content);
      if (!desc) continue;

      const existing = computationMap.get(desc);
      if (existing) {
        existing.count++;
        existing.locations.push(`${file.path}:${func.name}`);
      } else {
        computationMap.set(desc, { count: 1, locations: [`${file.path}:${func.name}`], description: desc });
      }
    }
  }

  for (const [desc, data] of computationMap) {
    if (data.count > 1) {
      computations.push({
        filePath: data.locations[0]!.split(':')[0]!,
        functionName: data.locations[0]!.split(':')[1]!,
        computationDescription: desc,
        occurrenceCount: data.count,
        source: 'ESTIMATED' as MeasurementSource,
        deduplicationSuggestion: `Extract to shared utility: ${desc}`,
      });
    }
  }

  return computations.slice(0, 15);
}

function summarizeComputation(content: string): string | null {
  if (content.includes('hash') || content.includes('md5') || content.includes('sha')) return 'cryptographic_hash';
  if (content.includes('parse') && content.includes('JSON')) return 'json_parsing';
  if (content.includes('validate') || content.includes('validate')) return 'validation';
  if (content.includes('transform') || content.includes('map')) return 'data_transformation';
  if (content.includes('calculate') || content.includes('compute')) return 'mathematical_computation';
  if (content.includes('format') || content.includes('format')) return 'string_formatting';
  return null;
}

async function analyzeApiLatency(userId: string, projectId: string, files: Awaited<ReturnType<typeof globalSearch>>): Promise<ApiLatencyRisk[]> {
  const risks: ApiLatencyRisk[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path || file.category === 'test') continue;
    const analysis = await readFileContent(userId, projectId, file.path as string);
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const routePatterns = [
      /app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
      /router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
    ];

    for (const regex of routePatterns) {
      let match;
      while ((match = regex.exec(f.content)) !== null) {
        const method = match[1]!.toUpperCase();
        const endpoint = match[2]!;
        const funcStart = match.index!;
        const funcBody = extractFunctionBody(f.content, funcStart);

        const bottlenecks: string[] = [];
        let estimatedP99 = 50;

        if (funcBody.includes('await') && funcBody.match(/await/g)!.length > 3) {
          bottlenecks.push('Multiple sequential awaits');
          estimatedP99 += 100;
        }
        if (funcBody.includes('SELECT') || funcBody.includes('query')) {
          bottlenecks.push('Database query in hot path');
          estimatedP99 += 50;
        }
        if (funcBody.includes('fetch') || funcBody.includes('axios')) {
          bottlenecks.push('External API call');
          estimatedP99 += 200;
        }
        if (funcBody.includes('forEach') || funcBody.includes('.map(')) {
          bottlenecks.push('Potential N+1 in handler');
          estimatedP99 += 30;
        }

        if (bottlenecks.length > 0) {
          risks.push({
            endpoint,
            method,
            estimatedP99Ms: Math.round(estimatedP99),
            source: 'ESTIMATED' as MeasurementSource,
            bottlenecks,
            scalingAdvice: generateScalingAdvice(bottlenecks),
          });
        }
      }
    }
  }

  return risks.slice(0, 20);
}

function generateScalingAdvice(bottlenecks: string[]): string[] {
  const advice: string[] = [];
  if (bottlenecks.some(b => b.includes('await'))) advice.push('Parallelize independent async operations');
  if (bottlenecks.some(b => b.includes('Database'))) advice.push('Add read replicas, optimize queries, consider caching');
  if (bottlenecks.some(b => b.includes('External'))) advice.push('Implement circuit breaker, timeout, and retry logic');
  if (bottlenecks.some(b => b.includes('N+1'))) advice.push('Use DataLoader or batch loading pattern');
  return advice;
}

function buildSummary(
  complexity: ComplexityAnalysis,
  slowFunctions: SlowFunction[],
  dbQueryRisks: DatabaseQueryRisk[],
  nPlusOnes: NPlusOneDetection[],
  cachingOpps: CachingOpportunity[],
  repeatedComps: RepeatedComputation[],
  apiRisks: ApiLatencyRisk[]
): PerformanceSummary {
  const critical = dbQueryRisks.filter(r => r.estimatedCost === 'CRITICAL').length +
    slowFunctions.filter(f => f.estimatedDurationMs > 200).length +
    apiRisks.filter(r => r.estimatedP99Ms > 500).length;
  const high = dbQueryRisks.filter(r => r.estimatedCost === 'HIGH').length +
    slowFunctions.filter(f => f.estimatedDurationMs > 100).length +
    nPlusOnes.length;
  const medium = dbQueryRisks.filter(r => r.estimatedCost === 'MEDIUM').length +
    slowFunctions.filter(f => f.estimatedDurationMs > 50).length +
    cachingOpps.length + repeatedComps.length;

  const totalIssues = critical + high + medium;
  const score = Math.max(0, 100 - critical * 15 - high * 8 - medium * 3);

  const recs: string[] = [];
  if (critical > 0) recs.push('Address CRITICAL database query risks immediately');
  if (high > 0) recs.push('Optimize HIGH-risk queries and slow functions');
  if (nPlusOnes.length > 0) recs.push('Fix N+1 query patterns with batch loading');
  if (cachingOpps.length > 0) recs.push('Implement caching for identified expensive computations');
  if (repeatedComps.length > 0) recs.push('Deduplicate repeated computations into shared utilities');

  return {
    overallScore: score,
    criticalIssues: critical,
    highIssues: high,
    mediumIssues: medium,
    estimatedOptimizationHours: Math.round(critical * 4 + high * 2 + medium * 1),
    topRecommendations: recs.slice(0, 5),
  };
}

export async function detectPerformanceRegressions(
  userId: string,
  projectId: string,
  baselineDate: Date,
  currentDate: Date
): Promise<PerformanceRegression> {
  await assertProjectAccess(userId, projectId);

  const regressions: RegressionItem[] = [];
  const improvements: ImprovementItem[] = [];

  const baselineFiles = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 200 });
  const currentFiles = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 200 });

  const baselineMetrics = await withTenant<{ metric_name: string; value: string }[]>(userId, (db) =>
    db
      .query<{ metric_name: string; value: string }>(
        `SELECT metric_name, value FROM performance_metrics WHERE project_id = $1 AND recorded_at <= $2 ORDER BY recorded_at DESC LIMIT 100`,
        [projectId, baselineDate.toISOString()],
      )
      .then((r) => r.rows),
  );

  const currentMetrics = await withTenant<{ metric_name: string; value: string }[]>(userId, (db) =>
    db
      .query<{ metric_name: string; value: string }>(
        `SELECT metric_name, value FROM performance_metrics WHERE project_id = $1 AND recorded_at <= $2 ORDER BY recorded_at DESC LIMIT 100`,
        [projectId, currentDate.toISOString()],
      )
      .then((r) => r.rows),
  );

  const baselineMap = new Map(baselineMetrics.map(r => [r.metric_name, Number(r.value)]));
  const currentMap = new Map(currentMetrics.map(r => [r.metric_name, Number(r.value)]));

  for (const [metric, baseline] of baselineMap) {
    const current = currentMap.get(metric);
    if (current !== undefined && current > (baseline as number) * 1.1) {
      regressions.push({
        metric,
        baseline: baseline as number,
        current,
        changePercent: ((current - (baseline as number)) / (baseline as number)) * 100,
        source: 'MEASURED' as MeasurementSource,
        likelyCause: 'Investigate recent changes to related code paths',
      });
    } else if (current !== undefined && current < (baseline as number) * 0.9) {
      improvements.push({
        metric,
        baseline: baseline as number,
        current,
        changePercent: ((current - (baseline as number)) / (baseline as number)) * 100,
        source: 'MEASURED' as MeasurementSource,
      });
    }
  }

  return { projectId, baselineDate, currentDate, regressions, improvements };
}