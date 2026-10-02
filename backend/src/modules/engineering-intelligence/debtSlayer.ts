/**
 * CodeConClave — Technical Debt Slayer (V4A).
 * Uses existing code analysis and task infrastructure.
 * ANALYZE → RECOMMEND → OPTIONAL TASK → EXISTING APPROVAL PIPELINE → EXECUTION
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { createTask, listTasks } from '../execution/tasks.js';
import { proposeApproval } from '../execution/approvals.js';
import { globalSearch } from '../search/service.js';
import { listDna } from '../dna/service.js';
import { logger } from '../../shared/logger.js';

export interface DebtItem {
  id: string;
  type: 'code_smell' | 'duplicate_code' | 'excessive_complexity' | 'large_function' | 'deep_nesting' | 'stale_code' | 'architectural_debt' | 'test_debt';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  affectedCode: AffectedCode;
  evidence: string;
  estimatedImpact: DebtImpact;
  recommendation: string;
  optionalTask?: DebtTask;
}

export interface AffectedCode {
  projectId: string;
  filePaths: string[];
  lines?: { start: number; end: number };
  symbols?: string[];
}

export interface DebtImpact {
  maintainability: number;
  performance: number;
  security: number;
  velocity: number;
  overall: number;
}

export interface DebtTask {
  id: string;
  title: string;
  description: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedEffort: 'SMALL' | 'MEDIUM' | 'LARGE';
  suggestedApproach: string;
}

export interface DebtAnalysisResult {
  projectId: string;
  totalItems: number;
  itemsBySeverity: Record<string, number>;
  itemsByType: Record<string, number>;
  items: DebtItem[];
  overallScore: number;
}

export interface DebtTrend {
  projectId: string;
  period: 'week' | 'month' | 'quarter';
  trend: 'improving' | 'stable' | 'worsening';
  scoreHistory: { timestamp: Date; score: number }[];
  newItems: number;
  resolvedItems: number;
}

const DEBT_TYPES = [
  'code_smell',
  'duplicate_code',
  'excessive_complexity',
  'large_function',
  'deep_nesting',
  'stale_code',
  'architectural_debt',
  'test_debt',
] as const;

const SEVERITY_ORDER = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function analyzeTechnicalDebt(userId: string, projectId: string): Promise<DebtAnalysisResult> {
  await assertProjectAccess(userId, projectId);

  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 500 });
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const tasks = await listTasks(userId, projectId);

  const items: DebtItem[] = [];

  for (const file of files.results) {
    if (!file.projectId || file.category === 'test') continue;
    const fileItems = await analyzeFile(file.label, file.projectId, userId);
    items.push(...fileItems);
  }

  const architecturalItems = await analyzeArchitecturalDebt(userId, projectId, dnaBlocks);
  items.push(...architecturalItems);

  const testDebtItems = await analyzeTestDebt(userId, projectId, tasks, files);
  items.push(...testDebtItems);

  const overallScore = calculateOverallScore(items);
  const itemsBySeverity = countBySeverity(items);
  const itemsByType = countByType(items);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'technical_debt_analysis',
    detail: { projectId, totalItems: items.length, overallScore, bySeverity: itemsBySeverity },
  });

  return {
    projectId,
    totalItems: items.length,
    itemsBySeverity,
    itemsByType,
    items: items.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
    overallScore,
  };
}

async function analyzeFile(filePath: string, projectId: string, userId: string): Promise<DebtItem[]> {
  const items: DebtItem[] = [];

  const analysis = await withTenant(userId, (q) => q.query(
    `SELECT path, category, content, updated_at FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
    [projectId, filePath]
  ));

  const file = analysis.rows[0];
  if (!file || !file.content) return items;

  const content = file.content;
  const lines = content.split('\n');
  const lineCount = lines.length;

  if (lineCount > 500) {
    items.push(createDebtItem(userId, projectId, filePath, 'large_function', 'HIGH', {
      maintainability: 0.7, performance: 0.3, security: 0.1, velocity: 0.5, overall: 0.5,
    }, `File has ${lineCount} lines (threshold: 500)`, 'Split into smaller modules'));
  }

  const functionPatterns = [
    /function\s+\w+\s*\([^)]*\)\s*\{/g,
    /const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /async\s+function\s+\w+\s*\([^)]*\)/g,
  ];

  for (const pattern of functionPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const funcStart = match.index;
      const funcLines = getFunctionLines(content, funcStart);
      if (funcLines > 100) {
        items.push(createDebtItem(userId, projectId, filePath, 'large_function', 'MEDIUM', {
          maintainability: 0.6, performance: 0.2, security: 0.1, velocity: 0.4, overall: 0.4,
        }, `Function at line ${getLineNumber(content, funcStart)} has ${funcLines} lines`, 'Extract into smaller functions'));
      }
    }
  }

  const nestingDepth = calculateMaxNesting(content);
  if (nestingDepth > 4) {
    items.push(createDebtItem(userId, projectId, filePath, 'deep_nesting', 'MEDIUM', {
      maintainability: 0.5, performance: 0.1, security: 0.1, velocity: 0.3, overall: 0.3,
    }, `Maximum nesting depth: ${nestingDepth} (threshold: 4)`, 'Flatten conditionals, extract guards'));
  }

  const complexity = calculateCyclomaticComplexity(content);
  if (complexity > 20) {
    items.push(createDebtItem(userId, projectId, filePath, 'excessive_complexity', 'HIGH', {
      maintainability: 0.8, performance: 0.3, security: 0.2, velocity: 0.6, overall: 0.6,
    }, `Cyclomatic complexity: ${complexity} (threshold: 20)`, 'Simplify logic, extract decision tables'));
  }

  const duplicateBlocks = findDuplicateBlocks(content, filePath, projectId);
  for (const dup of duplicateBlocks) {
    items.push(createDebtItem(userId, projectId, filePath, 'duplicate_code', 'MEDIUM', {
      maintainability: 0.6, performance: 0.1, security: 0.1, velocity: 0.3, overall: 0.3,
    }, `Duplicate code block (${dup.lines} lines) found at ${dup.locations.join(', ')}`, 'Extract to shared utility'));
  }

  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - 180);
  if (new Date(file.updated_at) < staleThreshold) {
    items.push(createDebtItem(userId, projectId, filePath, 'stale_code', 'LOW', {
      maintainability: 0.3, performance: 0.1, security: 0.2, velocity: 0.1, overall: 0.2,
    }, `File not modified in 180+ days`, 'Review if still needed, add tests if critical'));
  }

  return items;
}

function createDebtItem(
  userId: string,
  projectId: string,
  filePath: string,
  type: DebtItem['type'],
  severity: DebtItem['severity'],
  impact: DebtImpact,
  evidence: string,
  recommendation: string
): DebtItem {
  const id = `debt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    type,
    severity,
    affectedCode: { projectId, filePaths: [filePath] },
    evidence,
    estimatedImpact: impact,
    recommendation,
  };
}

function getFunctionLines(content: string, startIndex: number): number {
  let braceCount = 0;
  let inFunction = false;
  let lines = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      inFunction = true;
    } else if (content[i] === '}') {
      braceCount--;
      if (inFunction && braceCount === 0) break;
    }
    if (inFunction && content[i] === '\n') lines++;
  }
  return lines;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function calculateMaxNesting(content: string): number {
  let maxDepth = 0;
  let currentDepth = 0;
  const nestingChars = ['{', '(', '['];
  const closingChars = ['}', ')', ']'];
  for (const char of content) {
    if (nestingChars.includes(char)) {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (closingChars.includes(char)) {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }
  return maxDepth;
}

function calculateCyclomaticComplexity(content: string): number {
  const complexityPatterns = [
    /\bif\b/g,
    /\belse if\b/g,
    /\bwhile\b/g,
    /\bfor\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\b\?\b/g,
    /\b&&\b/g,
    /\b\|\|\b/g,
  ];
  let complexity = 1;
  for (const pattern of complexityPatterns) {
    const matches = content.match(pattern);
    if (matches) complexity += matches.length;
  }
  return complexity;
}

function findDuplicateBlocks(content: string, filePath: string, projectId: string): { lines: number; locations: string[] }[] {
  const lines = content.split('\n');
  const minBlockSize = 6;
  const blocks: Map<string, { lines: number; locations: string[] }> = new Map();

  for (let i = 0; i <= lines.length - minBlockSize; i++) {
    const block = lines.slice(i, i + minBlockSize).join('\n').trim();
    if (block.length < 50) continue;
    const existing = blocks.get(block);
    if (existing) {
      existing.locations.push(`${filePath}:${i + 1}`);
    } else {
      blocks.set(block, { lines: minBlockSize, locations: [`${filePath}:${i + 1}`] });
    }
  }

  return Array.from(blocks.values())
    .filter(b => b.locations.length > 1)
    .slice(0, 5);
}

async function analyzeArchitecturalDebt(userId: string, projectId: string, dnaBlocks: Awaited<ReturnType<typeof listDna>>): Promise<DebtItem[]> {
  const items: DebtItem[] = [];

  const decisionDna = dnaBlocks.filter(d => d.kind === 'DECISION');
  if (decisionDna.length === 0) {
    items.push(createDebtItem(userId, projectId, 'architecture', 'architectural_debt', 'MEDIUM', {
      maintainability: 0.5, performance: 0.1, security: 0.1, velocity: 0.4, overall: 0.3,
    }, 'No architecture DECISION DNA blocks found', 'Document key architectural decisions'));
  }

  const conflictDna = dnaBlocks.filter(d => d.conflict_state === 'CONFLICT');
  for (const dna of conflictDna) {
    items.push(createDebtItem(userId, projectId, 'architecture', 'architectural_debt', 'HIGH', {
      maintainability: 0.8, performance: 0.2, security: 0.1, velocity: 0.5, overall: 0.5,
    }, `DNA block "${dna.title}" in CONFLICT state`, 'Resolve DNA conflict via merge or explicit resolution'));
  }

  return items;
}

async function analyzeTestDebt(userId: string, projectId: string, tasks: Awaited<ReturnType<typeof listTasks>>, files: Awaited<ReturnType<typeof globalSearch>>): Promise<DebtItem[]> {
  const items: DebtItem[] = [];

  const testFiles = files.results.filter(f => f.category === 'test');
  const sourceFiles = files.results.filter(f => f.category !== 'test');

  if (sourceFiles.length > 0 && testFiles.length === 0) {
    items.push(createDebtItem(userId, projectId, 'test', 'test_debt', 'HIGH', {
      maintainability: 0.7, performance: 0.1, security: 0.3, velocity: 0.6, overall: 0.5,
    }, `${sourceFiles.length} source files with zero test files`, 'Add test infrastructure and first tests'));
  }

  const testCoverageRatio = testFiles.length / Math.max(sourceFiles.length, 1);
  if (testCoverageRatio < 0.3) {
    items.push(createDebtItem(userId, projectId, 'test', 'test_debt', 'MEDIUM', {
      maintainability: 0.5, performance: 0.1, security: 0.2, velocity: 0.4, overall: 0.3,
    }, `Test-to-source ratio: ${(testCoverageRatio * 100).toFixed(0)}% (target: 30%+)`, 'Increase test coverage for critical paths'));
  }

  return items;
}

function countBySeverity(items: DebtItem[]): Record<string, number> {
  const counts: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const item of items) {
    const sev = item.severity;
    if (sev in counts) counts[sev]!++;
  }
  return counts;
}

function countByType(items: DebtItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] || 0) + 1;
  }
  return counts;
}

function calculateOverallScore(items: DebtItem[]): number {
  if (items.length === 0) return 100;
  const weights = { LOW: 1, MEDIUM: 3, HIGH: 10, CRITICAL: 25 };
  let penalty = 0;
  for (const item of items) {
    penalty += weights[item.severity] * item.estimatedImpact.overall;
  }
  return Math.max(0, Math.round(100 - penalty));
}

export async function getDebtTrends(userId: string, projectId: string, period: 'week' | 'month' | 'quarter' = 'month'): Promise<DebtTrend> {
  await assertProjectAccess(userId, projectId);

  const days = period === 'week' ? 7 : period === 'month' ? 30 : 90;
  const interval = period === 'week' ? '1 day' : period === 'month' ? '1 day' : '7 days';

  const history = await pool.query(
    `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS count
     FROM technical_debt_log
     WHERE project_id = $1 AND created_at > now() - interval '${days} days'
     GROUP BY day ORDER BY day`,
    [projectId]
  );

  const scoreHistory = history.rows.map(r => ({
    timestamp: new Date(r.day),
    score: Math.max(0, 100 - r.count * 2),
  }));

  let trend: 'improving' | 'stable' | 'worsening' = 'stable';
  if (scoreHistory.length >= 2) {
    const recent = scoreHistory.slice(-3).reduce((a, b) => a + b.score, 0) / Math.min(3, scoreHistory.length);
    const older = scoreHistory.slice(0, 3).reduce((a, b) => a + b.score, 0) / Math.min(3, scoreHistory.length);
    if (recent > older + 5) trend = 'improving';
    else if (recent < older - 5) trend = 'worsening';
  }

  const newItems = await pool.query(
    `SELECT count(*)::int AS n FROM technical_debt_log
     WHERE project_id = $1 AND created_at > now() - interval '${days} days'`,
    [projectId]
  );

  const resolvedItems = await pool.query(
    `SELECT count(*)::int AS n FROM technical_debt_log
     WHERE project_id = $1 AND resolved_at IS NOT NULL AND resolved_at > now() - interval '${days} days'`,
    [projectId]
  );

  return {
    projectId,
    period,
    trend,
    scoreHistory,
    newItems: newItems.rows[0]?.n ?? 0,
    resolvedItems: resolvedItems.rows[0]?.n ?? 0,
  };
}

export async function createDebtResolutionTask(userId: string, projectId: string, debtItem: DebtItem): Promise<DebtTask> {
  const task = await createTaskFromDebt(userId, projectId, debtItem);
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    riskLevel: task.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    estimatedEffort: estimateEffort(debtItem),
    suggestedApproach: debtItem.recommendation,
  };
}

async function createTaskFromDebt(userId: string, projectId: string, debtItem: DebtItem) {
  const { createTaskFromChat } = await import('../execution/orchestrator.js');
  return createTaskFromChat({
    userId,
    projectId,
    conversationId: `debt-${debtItem.id}`,
    title: `Resolve: ${debtItem.type.replace('_', ' ')} in ${debtItem.affectedCode.filePaths[0]}`,
    description: `Technical debt: ${debtItem.evidence}\n\nRecommendation: ${debtItem.recommendation}\n\nImpact: ${JSON.stringify(debtItem.estimatedImpact, null, 2)}`,
    riskLevel: debtItem.severity,
    priority: SEVERITY_ORDER[debtItem.severity] * 2,
  });
}

function estimateEffort(debtItem: DebtItem): 'SMALL' | 'MEDIUM' | 'LARGE' {
  const score = debtItem.estimatedImpact.overall * SEVERITY_ORDER[debtItem.severity];
  if (score < 3) return 'SMALL';
  if (score < 8) return 'MEDIUM';
  return 'LARGE';
}

export async function proposeDebtResolution(userId: string, projectId: string, debtItem: DebtItem): Promise<string> {
  const taskId = await createTaskFromDebt(userId, projectId, debtItem).then(t => t.id);
  const approvalResult = await proposeApproval(userId, {
    actionType: 'debt_resolution',
    riskLevel: debtItem.severity as any,
    justification: debtItem.recommendation,
    affectedResources: debtItem.affectedCode.filePaths.map(f => ({ type: 'file', ref: f })),
    proposedAction: {
      type: 'debt_resolution',
      debtItemId: debtItem.id,
      debtType: debtItem.type,
      affectedFiles: debtItem.affectedCode.filePaths,
      recommendation: debtItem.recommendation,
    },
  });
  if (!approvalResult.approval) throw AppError.badRequest('approval_failed', 'Failed to create approval');
  return approvalResult.approval.id;
}