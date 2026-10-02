/**
 * CodeConClave — Testing Strategy Generator (V4B).
 * Uses existing testing/agent infrastructure (agents, tasks, approvals, coworkers).
 * Generates: unit test suggestions, integration test suggestions, E2E test suggestions,
 * edge cases, regression tests, security tests.
 * Provides: SUGGESTION → DIFF → APPROVAL → TEST
 * Does not automatically modify tests without approval.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { globalSearch } from '../search/service.js';
import { createTask } from '../execution/tasks.js';
import { proposeApproval } from '../execution/approvals.js';

export interface TestSuggestion {
  id: string;
  type: 'unit' | 'integration' | 'e2e' | 'edge_case' | 'regression' | 'security';
  targetFile: string;
  targetSymbol?: string;
  title: string;
  description: string;
  suggestedTestCode: string;
  confidence: number;
  rationale: string;
  relatedFiles: string[];
}

export interface TestStrategy {
  projectId: string;
  suggestions: TestSuggestion[];
  coverageGaps: CoverageGap[];
  prioritizedOrder: string[];
}

export interface CoverageGap {
  filePath: string;
  symbolName?: string;
  gapType: 'uncovered_lines' | 'uncovered_branches' | 'missing_tests' | 'weak_assertions';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  uncoveredLines?: number[];
  description: string;
}

export interface TestSuggestionDiff {
  suggestionId: string;
  testFilePath: string;
  diff: string;
  newFile: boolean;
}

export interface ApprovedTestSuggestion {
  suggestionId: string;
  taskId: string;
  approvalId: string;
}

export interface TestGenerationOptions {
  types?: TestSuggestion['type'][];
  targetFiles?: string[];
  includeSecurityTests?: boolean;
  includeEdgeCases?: boolean;
  minConfidence?: number;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]),
  );
  if (!p.rows[0]) throw AppError.notFound('Project');
}

function inferTestType(filePath: string, symbolName?: string): TestSuggestion['type'] {
  if (filePath.includes('.test.') || filePath.includes('.spec.')) return 'unit';
  if (filePath.includes('integration') || filePath.includes('e2e')) return 'e2e';
  if (filePath.includes('security') || filePath.includes('auth')) return 'security';
  return 'unit';
}

async function analyzeFileForGaps(userId: string, projectId: string, filePath: string): Promise<CoverageGap[]> {
  const gaps: CoverageGap[] = [];
  const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
    q.query<{ path: string; content: string }>(
      `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [projectId, filePath],
    ).then((r) => r.rows[0] ?? null),
  );
  if (!analysis || !analysis.content) return gaps;

  const content = analysis.content;
  const lines = content.split('\n');

  const hasTestFile = await withTenant<{ one: number } | null>(userId, (q) =>
    q.query<{ one: number }>(
      `SELECT 1 AS one FROM files WHERE project_id = $1 AND (path ILIKE '%.test.%' OR path ILIKE '%.spec.%') AND path LIKE '%' || $2 || '%' AND deleted_at IS NULL`,
      [projectId, filePath.replace(/\.[^.]+$/, '')],
    ).then((r) => r.rows[0] ?? null),
  );

  if (!hasTestFile) {
    gaps.push({
      filePath,
      gapType: 'missing_tests',
      severity: 'HIGH',
      description: 'No corresponding test file found for this source file',
    });
  }

  const functionPatterns = [
    /function\s+(\w+)\s*\([^)]*\)/g,
    /const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /async\s+function\s+(\w+)\s*\([^)]*\)/g,
  ];

  const functions: string[] = [];
  for (const pattern of functionPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
    const m = match[1];
    if (m) functions.push(m);
    }
  }

  if (functions.length > 0 && !hasTestFile) {
    gaps.push({
      filePath,
      gapType: 'uncovered_lines',
      severity: 'MEDIUM',
      description: `${functions.length} exported functions without test coverage`,
    });
  }

  if (content.includes('try') && content.includes('catch') && !content.includes('expect') && !content.includes('assert')) {
    gaps.push({
      filePath,
      gapType: 'weak_assertions',
      severity: 'MEDIUM',
      description: 'Error handling present but no assertions found in tests',
    });
  }

  return gaps;
}

export async function generateTestStrategy(
  userId: string,
  projectId: string,
  options: TestGenerationOptions = {}
): Promise<TestStrategy> {
  await assertProjectAccess(userId, projectId);

  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 300 });
  const sourceFiles = files.results.filter(f => f.projectId && f.category !== 'test');

  const allSuggestions: TestSuggestion[] = [];
  const allGaps: CoverageGap[] = [];

  for (const file of sourceFiles) {
    if (!file.projectId || !file.path) continue;
    const filePath = file.path as string;
    const gaps = await analyzeFileForGaps(userId, projectId, filePath);
    allGaps.push(...gaps);

    if (options.targetFiles && !options.targetFiles.includes(filePath)) continue;

    const suggestions = await generateSuggestionsForFile(userId, projectId, filePath, options);
    allSuggestions.push(...suggestions);
  }

  const filteredSuggestions = options.minConfidence
    ? allSuggestions.filter(s => s.confidence >= options.minConfidence!)
    : allSuggestions;

  if (options.types) {
    filteredSuggestions.filter(s => options.types!.includes(s.type));
  }

  const prioritizedOrder = prioritizeSuggestions(filteredSuggestions, allGaps);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'test_strategy',
    detail: { projectId, suggestions: filteredSuggestions.length, gaps: allGaps.length },
  });

  return {
    projectId,
    suggestions: filteredSuggestions,
    coverageGaps: allGaps,
    prioritizedOrder,
  };
}

async function generateSuggestionsForFile(
  userId: string,
  projectId: string,
  filePath: string,
  options: TestGenerationOptions
): Promise<TestSuggestion[]> {
  const suggestions: TestSuggestion[] = [];
  const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
    q.query<{ path: string; content: string }>(
      `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [projectId, filePath],
    ).then((r) => r.rows[0] ?? null),
  );
  if (!analysis || !analysis.content) return suggestions;

  const content = analysis.content;
  const testType = inferTestType(filePath);

  const functionPatterns = [
    { regex: /function\s+(\w+)\s*\(([^)]*)\)/g, type: 'function' },
    { regex: /const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g, type: 'arrow' },
    { regex: /async\s+function\s+(\w+)\s*\(([^)]*)\)/g, type: 'async' },
    { regex: /class\s+(\w+)/g, type: 'class' },
  ];

  const functions: { name: string; type: string; params: string }[] = [];
  for (const { regex, type } of functionPatterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
    const m = match[1];
    if (m) functions.push({ name: m, type, params: match[2] || '' });
  }
  }

  for (const fn of functions) {
    if (options.types && !options.types.includes(testType)) continue;

    const suggestion: TestSuggestion = {
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type: testType,
      targetFile: filePath,
      targetSymbol: fn.name,
      title: `Test ${fn.name} (${fn.type})`,
      description: `Generated test for ${fn.type} ${fn.name} with parameters: ${fn.params}`,
      suggestedTestCode: generateTestTemplate(fn, testType),
      confidence: 0.75,
      rationale: `${fn.type} ${fn.name} is exported and lacks dedicated tests`,
      relatedFiles: [filePath],
    };
    suggestions.push(suggestion);
  }

  if (options.includeEdgeCases && content.includes('if') && content.includes('else')) {
    suggestions.push({
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type: 'edge_case',
      targetFile: filePath,
      title: 'Edge case tests for conditional branches',
      description: 'Generate tests covering all conditional branches',
      suggestedTestCode: generateEdgeCaseTemplate(filePath),
      confidence: 0.6,
      rationale: 'Multiple conditional branches detected without explicit edge case coverage',
      relatedFiles: [filePath],
    });
  }

  if (options.includeSecurityTests && (content.includes('password') || content.includes('token') || content.includes('secret') || content.includes('auth'))) {
    suggestions.push({
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type: 'security',
      targetFile: filePath,
      title: 'Security tests for sensitive operations',
      description: 'Generate tests for authentication/authorization flows and secret handling',
      suggestedTestCode: generateSecurityTestTemplate(filePath),
      confidence: 0.65,
      rationale: 'Sensitive operations detected (auth, tokens, secrets) requiring security validation',
      relatedFiles: [filePath],
    });
  }

  return suggestions;
}

function generateTestTemplate(fn: { name: string; type: string; params: string }, testType: string): string {
  const paramNames = fn.params.split(',').map(p => p.trim().split(':')[0]?.trim() ?? '').filter(Boolean);
  const params = paramNames.map(p => `${p}: ${p === 'input' ? 'testInput' : 'mockValue'}`).join(', ');

  return `import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ${fn.name} } from '../${fn.name}';

describe('${fn.name}', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle basic case', () => {
    const result = ${fn.name}(${params});
    expect(result).toBeDefined();
  });

  it('should handle edge cases', () => {
    // TODO: Add edge case tests
  });

  it('should handle errors gracefully', () => {
    // TODO: Add error handling tests
  });
});`;
}

function generateEdgeCaseTemplate(filePath: string): string {
  return `import { describe, it, expect } from 'vitest';

describe('Edge cases for ${filePath}', () => {
  it('should handle null/undefined inputs', () => {
    // TODO: Test null/undefined handling
  });

  it('should handle empty inputs', () => {
    // TODO: Test empty string/array/object
  });

  it('should handle boundary values', () => {
    // TODO: Test min/max boundaries
  });

  it('should handle concurrent operations', () => {
    // TODO: Test race conditions if applicable
  });
});`;
}

function generateSecurityTestTemplate(filePath: string): string {
  return `import { describe, it, expect, vi } from 'vitest';

describe('Security tests for ${filePath}', () => {
  it('should not expose secrets in logs/errors', () => {
    // TODO: Verify no secrets in error messages
  });

  it('should validate and sanitize inputs', () => {
    // TODO: Test input validation
  });

  it('should enforce authorization checks', () => {
    // TODO: Test auth/authorization
  });

  it('should handle authentication failures gracefully', () => {
    // TODO: Test auth failure scenarios
  });
});`;
}

function prioritizeSuggestions(suggestions: TestSuggestion[], gaps: CoverageGap[]): string[] {
  const scored = suggestions.map(s => ({
    id: s.id,
    score: s.confidence * (gaps.some(g => g.filePath === s.targetFile && g.severity === 'CRITICAL') ? 2 : gaps.some(g => g.filePath === s.targetFile && g.severity === 'HIGH') ? 1.5 : 1),
  }));
  return scored.sort((a, b) => b.score - a.score).map(s => s.id);
}

export async function generateTestDiff(
  userId: string,
  projectId: string,
  suggestionId: string,
  strategy: TestStrategy
): Promise<TestSuggestionDiff> {
  const suggestion = strategy.suggestions.find(s => s.id === suggestionId);
  if (!suggestion) throw AppError.notFound('Suggestion');

  const testFilePath = suggestion.targetFile.replace(/\.ts$/, '.test.ts').replace(/\.js$/, '.test.js');

  return {
    suggestionId,
    testFilePath,
    diff: generateUnifiedDiff(testFilePath, suggestion.suggestedTestCode),
    newFile: true,
  };
}

function generateUnifiedDiff(filePath: string, newContent: string): string {
  return `--- /dev/null
+++ b/${filePath}
@@ -0,0 +1,${newContent.split('\n').length} @@
${newContent.split('\n').map(line => `+${line}`).join('\n')}`;
}

export async function proposeTestSuggestion(
  userId: string,
  projectId: string,
  suggestionId: string,
  strategy: TestStrategy
): Promise<ApprovedTestSuggestion> {
  const suggestion = strategy.suggestions.find(s => s.id === suggestionId);
  if (!suggestion) throw AppError.notFound('Suggestion');

  const diff = await generateTestDiff(userId, projectId, suggestionId, strategy);

  const task = await createTask({
    userId,
    projectId,
    title: `Add test: ${suggestion.title}`,
    description: `Implement test: ${suggestion.description}\n\nDiff:\n${diff.diff}`,
    riskLevel: 'LOW',
    priority: 2,
  });

  const approval = await proposeApproval(userId, {
    taskId: task.id,
    actionType: 'test_suggestion',
    riskLevel: 'LOW',
    justification: `Add test for ${suggestion.targetSymbol || 'function'} in ${suggestion.targetFile}`,
    affectedResources: [{ type: 'file', ref: diff.testFilePath }],
    proposedAction: { type: 'create_test', filePath: diff.testFilePath, content: suggestion.suggestedTestCode },
  });

  return { suggestionId, taskId: task.id, approvalId: approval.approval?.id ?? '' };
}